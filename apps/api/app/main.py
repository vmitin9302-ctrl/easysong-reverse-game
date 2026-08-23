import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import AnalyticsEvent, DuelMatch, DuelRound, GameResult, GameSession, OutboundClick, ShareLink
from .settings import settings
from .storage import delete_objects, signed_get, signed_put
from .telegram_auth import TelegramAuthError, validate_init_data


class SessionCreate(BaseModel):
    source: str = 'direct'
    campaign: str | None = None
    medium: str | None = None
    referral_token: str | None = None
    platform: str = 'web'


class ResultCreate(BaseModel):
    score: int = Field(ge=0, le=100)
    original_duration_ms: int = Field(gt=0, le=20_000)
    attempt_duration_ms: int = Field(gt=0, le=20_000)
    acoustic_similarity: float = Field(ge=0, le=1)
    rhythm_similarity: float = Field(ge=0, le=1)
    duration_similarity: float = Field(ge=0, le=1)


class EventCreate(BaseModel):
    session_id: uuid.UUID | None = None
    event_name: str = Field(min_length=1, max_length=96)
    properties: dict = Field(default_factory=dict)


class EventBatch(BaseModel):
    events: list[EventCreate] = Field(max_length=100)


class ShareCreate(BaseModel):
    creator_session_id: uuid.UUID
    score: int = Field(ge=0, le=100)


class TelegramAuthRequest(BaseModel):
    init_data: str = Field(min_length=1, max_length=16_384)


class MatchCreate(BaseModel):
    session_id: uuid.UUID | None = None


class AudioUploadRequest(BaseModel):
    content_type: str = Field(default='audio/wav', pattern=r'^audio/[a-zA-Z0-9.+-]+$')


class RoundScoreRequest(BaseModel):
    score: int = Field(ge=0, le=100)
    acoustic_similarity: float = Field(ge=0, le=1)
    rhythm_similarity: float = Field(ge=0, le=1)
    duration_similarity: float = Field(ge=0, le=1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if engine is not None:
        Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title='EasySong Reverse Game API', version='0.1.0', lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.allowed_origins.split(',') if origin.strip()],
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['Content-Type', 'Authorization', 'X-Player-Token'],
)


def require_database(db: Session | None) -> Session:
    if db is None:
        raise HTTPException(status_code=503, detail='Match service requires a database')
    return db


def match_player(match: DuelMatch, token: str | None) -> int:
    if token and secrets.compare_digest(token, match.player_one_secret):
        return 1
    if token and match.player_two_secret and secrets.compare_digest(token, match.player_two_secret):
        return 2
    raise HTTPException(status_code=403, detail='Invalid player token')


def match_view(db: Session, match: DuelMatch, player: int) -> dict:
    rounds = db.query(DuelRound).filter(DuelRound.match_id == match.id).order_by(DuelRound.round_number).all()
    forfeited_by = int(match.status.rsplit('_', 1)[-1]) if match.status.startswith('forfeited_by_') else None
    return {
        'id': str(match.id), 'invite_token': match.invite_token, 'player': player, 'status': match.status,
        'forfeited_by': forfeited_by,
        'rounds': [
            {'number': row.round_number, 'challenger': row.challenger, 'responder': row.responder,
             'status': row.status, 'score': row.score, 'audio_expires_at': row.audio_expires_at}
            for row in rounds
        ],
    }


def active_round(db: Session, match_id: uuid.UUID, number: int) -> DuelRound:
    row = db.query(DuelRound).filter(DuelRound.match_id == match_id, DuelRound.round_number == number).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail='Round not found')
    return row


def ensure_audio_available(row: DuelRound) -> None:
    expires_at = row.audio_expires_at
    if expires_at is None or expires_at <= datetime.now(UTC):
        raise HTTPException(status_code=410, detail='Temporary audio has expired')


@app.post('/v1/matches', status_code=201)
def create_match(payload: MatchCreate, db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    if payload.session_id and db.get(GameSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail='Session not found')
    match = DuelMatch(session_id=payload.session_id, invite_token=secrets.token_urlsafe(9), player_one_secret=secrets.token_urlsafe(32))
    db.add(match)
    db.flush()
    db.add_all([
        DuelRound(match_id=match.id, round_number=1, challenger=1, responder=2),
        DuelRound(match_id=match.id, round_number=2, challenger=2, responder=1),
    ])
    db.commit()
    return {**match_view(db, match, 1), 'player_token': match.player_one_secret}


@app.post('/v1/matches/join/{invite_token}')
def join_match(invite_token: str, db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.query(DuelMatch).filter(DuelMatch.invite_token == invite_token).with_for_update().one_or_none()
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    if match.status == 'cancelled':
        raise HTTPException(status_code=410, detail='Match was cancelled')
    if match.player_two_secret:
        raise HTTPException(status_code=409, detail='Match already has two players')
    match.player_two_secret = secrets.token_urlsafe(32)
    match.status = 'round_1'
    db.commit()
    return {**match_view(db, match, 2), 'player_token': match.player_two_secret}


@app.post('/v1/matches/{match_id}/cancel')
def cancel_match(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.get(DuelMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    if match_player(match, x_player_token) != 1:
        raise HTTPException(status_code=403, detail='Only player one can cancel the match')
    if match.status != 'waiting_for_player_2' or match.player_two_secret:
        raise HTTPException(status_code=409, detail='A started match cannot be cancelled')
    match.status = 'cancelled'
    match.finished_at = datetime.now(UTC)
    db.commit()
    return {'cancelled': True}


@app.post('/v1/matches/{match_id}/forfeit')
def forfeit_match(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.get(DuelMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    player = match_player(match, x_player_token)
    if match.status not in ('round_1', 'round_2') or not match.player_two_secret:
        raise HTTPException(status_code=409, detail='Only an active match can be forfeited')
    rounds = db.query(DuelRound).filter(DuelRound.match_id == match.id).all()
    keys = [key for row in rounds for key in (row.challenge_object_key, row.attempt_object_key) if key]
    for row in rounds:
        row.challenge_object_key = None
        row.attempt_object_key = None
    match.status = f'forfeited_by_{player}'
    match.finished_at = datetime.now(UTC)
    db.commit()
    try:
        delete_objects(keys)
    except Exception:
        pass
    return match_view(db, match, player)


@app.get('/v1/matches/{match_id}')
def get_match(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.get(DuelMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    return match_view(db, match, match_player(match, x_player_token))


@app.post('/v1/matches/{match_id}/rounds/{number}/challenge-upload')
def challenge_upload(match_id: uuid.UUID, number: int, payload: AudioUploadRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    player = match_player(match, x_player_token); round_row = active_round(db, match_id, number)
    if player != round_row.challenger or round_row.status != 'awaiting_challenge': raise HTTPException(status_code=409, detail='Challenge upload is not allowed now')
    key = f'matches/{match_id}/round-{number}/challenge-{secrets.token_hex(12)}.wav'
    try: url = signed_put(key, payload.content_type)
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    round_row.challenge_object_key = key; round_row.audio_expires_at = datetime.now(UTC) + timedelta(seconds=settings.audio_ttl_seconds)
    db.commit(); return {'upload_url': url, 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/challenge-ready')
def challenge_ready(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    if match_player(match, x_player_token) != round_row.challenger or not round_row.challenge_object_key: raise HTTPException(status_code=409, detail='Challenge is not uploaded')
    round_row.status = 'awaiting_attempt'; db.commit(); return {'accepted': True}


@app.get('/v1/matches/{match_id}/rounds/{number}/challenge-audio')
def challenge_audio(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    if match_player(match, x_player_token) != round_row.responder or round_row.status != 'awaiting_attempt': raise HTTPException(status_code=409, detail='Audio is not available')
    ensure_audio_available(round_row)
    return {'download_url': signed_get(round_row.challenge_object_key), 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/attempt-upload')
def attempt_upload(match_id: uuid.UUID, number: int, payload: AudioUploadRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    if match_player(match, x_player_token) != round_row.responder or round_row.status != 'awaiting_attempt': raise HTTPException(status_code=409, detail='Attempt upload is not allowed now')
    key = f'matches/{match_id}/round-{number}/attempt-{secrets.token_hex(12)}.wav'
    try: url = signed_put(key, payload.content_type)
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    round_row.attempt_object_key = key
    round_row.audio_expires_at = datetime.now(UTC) + timedelta(seconds=settings.audio_ttl_seconds)
    db.commit(); return {'upload_url': url, 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/attempt-ready')
def attempt_ready(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    if match_player(match, x_player_token) != round_row.responder or not round_row.attempt_object_key: raise HTTPException(status_code=409, detail='Attempt is not uploaded')
    round_row.status = 'awaiting_score'; db.commit(); return {'accepted': True}


@app.get('/v1/matches/{match_id}/rounds/{number}/attempt-audio')
def attempt_audio(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    if match_player(match, x_player_token) != round_row.challenger or round_row.status != 'awaiting_score': raise HTTPException(status_code=409, detail='Attempt is not available')
    ensure_audio_available(round_row)
    return {'download_url': signed_get(round_row.attempt_object_key), 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/score')
def submit_round_score(match_id: uuid.UUID, number: int, payload: RoundScoreRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    row = active_round(db, match_id, number)
    if match_player(match, x_player_token) != row.challenger or row.status != 'awaiting_score': raise HTTPException(status_code=409, detail='Score is not allowed now')
    row.score = payload.score; row.score_breakdown = payload.model_dump(); row.status = 'complete'
    if number == 1: match.status = 'round_2'
    else: match.status = 'finished'; match.finished_at = datetime.now(UTC)
    keys = [key for key in (row.challenge_object_key, row.attempt_object_key) if key]
    row.challenge_object_key = None; row.attempt_object_key = None; db.commit()
    try: delete_objects(keys)
    except Exception: pass
    return match_view(db, match, match_player(match, x_player_token))


@app.get('/health')
def health() -> dict:
    return {'status': 'ok', 'database': engine is not None}


@app.post('/v1/auth/telegram')
def auth_telegram(payload: TelegramAuthRequest) -> dict:
    if not settings.telegram_bot_token:
        raise HTTPException(status_code=503, detail='Telegram auth is not configured')
    try:
        return validate_init_data(payload.init_data)
    except TelegramAuthError as exc:
        raise HTTPException(status_code=401, detail='Invalid Telegram init data') from exc


@app.post('/v1/sessions', status_code=201)
def create_session(payload: SessionCreate, db: Session | None = Depends(get_db)) -> dict:
    session_id = uuid.uuid4()
    if db is not None:
        row = GameSession(
            id=session_id,
            source=payload.source[:32],
            campaign=payload.campaign[:128] if payload.campaign else None,
            medium=payload.medium[:128] if payload.medium else None,
            referral_token=payload.referral_token[:64] if payload.referral_token else None,
            platform=payload.platform[:32],
        )
        db.add(row)
        db.commit()
    return {'id': str(session_id), 'created_at': datetime.now(UTC).isoformat()}


@app.post('/v1/sessions/{session_id}/result', status_code=201)
def save_result(
    session_id: uuid.UUID,
    payload: ResultCreate,
    db: Session | None = Depends(get_db),
) -> dict:
    result_id = uuid.uuid4()
    if db is not None:
        session = db.get(GameSession, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail='Session not found')
        row = GameResult(id=result_id, session_id=session_id, **payload.model_dump())
        session.status = 'finished'
        session.finished_at = datetime.now(UTC)
        db.add(row)
        db.commit()
    return {'id': str(result_id), 'session_id': str(session_id), 'score': payload.score}


@app.post('/v1/events', status_code=202)
def save_event(payload: EventCreate, db: Session | None = Depends(get_db)) -> dict:
    if db is not None:
        db.add(AnalyticsEvent(**payload.model_dump()))
        db.commit()
    return {'accepted': True}


@app.post('/v1/events/batch', status_code=202)
def save_events(payload: EventBatch, db: Session | None = Depends(get_db)) -> dict:
    if db is not None and payload.events:
        db.add_all([AnalyticsEvent(**event.model_dump()) for event in payload.events])
        db.commit()
    return {'accepted': len(payload.events)}


@app.post('/v1/shares', status_code=201)
def create_share(payload: ShareCreate, db: Session | None = Depends(get_db)) -> dict:
    token = secrets.token_urlsafe(6)
    if db is not None:
        if db.get(GameSession, payload.creator_session_id) is None:
            raise HTTPException(status_code=404, detail='Session not found')
        db.add(
            ShareLink(
                token=token,
                creator_session_id=payload.creator_session_id,
                score=payload.score,
            )
        )
        db.commit()
    return {'token': token, 'score': payload.score}


@app.get('/v1/shares/{token}')
def get_share(token: str, db: Session | None = Depends(get_db)) -> dict:
    if db is None:
        raise HTTPException(status_code=404, detail='Share not found')
    row = db.query(ShareLink).filter(ShareLink.token == token).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail='Share not found')
    return {'token': row.token, 'score': row.score}


@app.get('/go/easysong')
def go_easysong(
    source: str | None = Query(default=None, max_length=32),
    campaign: str | None = Query(default=None, max_length=128),
    sid: uuid.UUID | None = None,
    db: Session | None = Depends(get_db),
):
    if db is not None:
        try:
            db.add(
                OutboundClick(
                    session_id=sid,
                    destination='easysong',
                    source=source,
                    campaign=campaign,
                )
            )
            db.commit()
        except Exception:
            db.rollback()
    return RedirectResponse(settings.easysong_url, status_code=302)
