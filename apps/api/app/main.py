import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import AnalyticsEvent, DuelMatch, DuelRound, GameResult, GameSession, OutboundClick, ShareLink
from .migrations import apply_runtime_migrations
from .settings import settings
from .storage import delete_objects, signed_get, signed_put
from .telegram_auth import TelegramAuthError, validate_init_data


logger = logging.getLogger(__name__)


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
    page: str | None = Field(default=None, max_length=128)
    section: str | None = Field(default=None, max_length=96)
    element: str | None = Field(default=None, max_length=128)
    action: str | None = Field(default=None, max_length=64)
    anonymous_id: str | None = Field(default=None, max_length=64)
    source: str | None = Field(default=None, max_length=64)
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
    idempotency_key: str = Field(min_length=8, max_length=96)


class JoinMatchRequest(BaseModel):
    participant_token: str | None = Field(default=None, min_length=16, max_length=96)


class ActivityUpdate(BaseModel):
    status: str = Field(min_length=1, max_length=48)


class RoundPhraseRequest(BaseModel):
    phrase: str = Field(min_length=1, max_length=160)


class RoundGuessRequest(BaseModel):
    guess: str = Field(min_length=1, max_length=160)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if engine is not None:
        apply_runtime_migrations(engine, Base.metadata)
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
    player_scores: list[int | None] = [None, None]
    for row in rounds:
        if row.score is not None:
            player_scores[row.responder - 1] = row.score
    winner = None
    if forfeited_by:
        winner = 2 if forfeited_by == 1 else 1
    elif match.status == 'finished' and all(score is not None for score in player_scores):
        if player_scores[0] != player_scores[1]:
            winner = 1 if player_scores[0] > player_scores[1] else 2
    return {
        'id': str(match.id), 'invite_token': match.invite_token, 'player': player, 'status': match.status,
        'current_round': match.current_round, 'active_player': match.active_player,
        'revision': match.revision, 'updated_at': match.updated_at,
        'activity_status': match.activity_status, 'activity_player': match.activity_player,
        'activity_updated_at': match.activity_updated_at,
        'player_one_last_seen_at': match.player_one_last_seen_at,
        'player_two_last_seen_at': match.player_two_last_seen_at,
        'invite_expires_at': match.invite_expires_at,
        'rematch_requested_by': match.rematch_requested_by,
        'scores': player_scores, 'winner': winner,
        'forfeited_by': forfeited_by,
        'rounds': [round_view(row, player) for row in rounds],
    }


def round_view(row: DuelRound, player: int) -> dict:
    revealed = row.status == 'complete'
    result_seen = row.challenger_result_seen if player == row.challenger else row.responder_result_seen
    return {
        'number': row.round_number,
        'challenger': row.challenger,
        'responder': row.responder,
        'status': row.status,
        'phrase': row.phrase_text if player == row.challenger or revealed else None,
        'guess': row.guess_text if player == row.responder or revealed else None,
        'score': row.score,
        'audio_expires_at': row.audio_expires_at,
        'attempt_available': bool(row.attempt_object_key),
        'result_seen': result_seen,
    }


def normalized_phrase(value: str) -> str:
    simplified = ''.join(character if character.isalnum() else ' ' for character in value.casefold().replace('ё', 'е'))
    return ' '.join(simplified.split())


def phrase_score(phrase: str, guess: str) -> int:
    expected, actual = normalized_phrase(phrase), normalized_phrase(guess)
    if not expected or not actual:
        return 0
    return round(100 * SequenceMatcher(None, expected, actual).ratio())


def bump(match: DuelMatch, *, activity: str | None = None, player: int | None = None) -> None:
    match.revision += 1
    match.updated_at = datetime.now(UTC)
    if activity is not None:
        match.activity_status = activity
        match.activity_player = player
        match.activity_updated_at = datetime.now(UTC)


def locked_match(db: Session, match_id: uuid.UUID) -> DuelMatch:
    match = db.query(DuelMatch).filter(DuelMatch.id == match_id).with_for_update().one_or_none()
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    return match


def ensure_current_turn(match: DuelMatch, number: int, player: int) -> None:
    if match.status != f'round_{number}' or match.current_round != number or match.active_player != player:
        raise HTTPException(status_code=409, detail='This is not the active turn')


def active_round(db: Session, match_id: uuid.UUID, number: int) -> DuelRound:
    row = db.query(DuelRound).filter(DuelRound.match_id == match_id, DuelRound.round_number == number).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail='Round not found')
    return row


def has_expired(value: datetime | None) -> bool:
    if value is None:
        return False
    comparable = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return comparable <= datetime.now(UTC)


def ensure_audio_available(row: DuelRound) -> None:
    if row.audio_expires_at is None or has_expired(row.audio_expires_at):
        raise HTTPException(status_code=410, detail='Temporary audio has expired')


def storage_put_url(key: str, content_type: str) -> str:
    try:
        return signed_put(key, content_type)
    except Exception as exc:
        raise HTTPException(status_code=503, detail='Temporary audio storage is unavailable') from exc


def storage_get_url(key: str) -> str:
    try:
        return signed_get(key)
    except Exception as exc:
        raise HTTPException(status_code=503, detail='Temporary audio storage is unavailable') from exc


@app.post('/v1/matches', status_code=201)
def create_match(payload: MatchCreate, db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    if payload.session_id and db.get(GameSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail='Session not found')
    now = datetime.now(UTC)
    match = DuelMatch(
        session_id=payload.session_id,
        invite_token=secrets.token_urlsafe(9),
        player_one_secret=secrets.token_urlsafe(32),
        player_one_last_seen_at=now,
        invite_expires_at=now + timedelta(seconds=settings.invite_ttl_seconds),
    )
    db.add(match)
    db.flush()
    db.add_all([
        DuelRound(match_id=match.id, round_number=1, challenger=1, responder=2, status='awaiting_phrase'),
        DuelRound(match_id=match.id, round_number=2, challenger=2, responder=1, status='awaiting_phrase'),
    ])
    db.commit()
    return {**match_view(db, match, 1), 'player_token': match.player_one_secret}


@app.post('/v1/matches/join/{invite_token}')
def join_match(invite_token: str, payload: JoinMatchRequest, db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.query(DuelMatch).filter(DuelMatch.invite_token == invite_token).with_for_update().one_or_none()
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    if match.status == 'cancelled':
        raise HTTPException(status_code=410, detail='Match was cancelled')
    if payload.participant_token:
        try:
            player = match_player(match, payload.participant_token)
        except HTTPException:
            player = 0
        if player:
            if player == 1: match.player_one_last_seen_at = datetime.now(UTC)
            else: match.player_two_last_seen_at = datetime.now(UTC)
            bump(match)
            db.commit()
            return {**match_view(db, match, player), 'player_token': payload.participant_token}
    if has_expired(match.invite_expires_at):
        raise HTTPException(status_code=410, detail='Invite has expired')
    if match.player_two_secret:
        raise HTTPException(status_code=409, detail='Match already has two players')
    match.player_two_secret = secrets.token_urlsafe(32)
    match.status = 'round_1'
    match.current_round = 1
    match.active_player = 1
    match.player_two_last_seen_at = datetime.now(UTC)
    bump(match, activity='opponent_joined', player=2)
    db.commit()
    return {**match_view(db, match, 2), 'player_token': match.player_two_secret}


@app.post('/v1/matches/{match_id}/cancel')
def cancel_match(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.query(DuelMatch).filter(DuelMatch.id == match_id).with_for_update().one_or_none()
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    if match_player(match, x_player_token) != 1:
        raise HTTPException(status_code=403, detail='Only player one can cancel the match')
    if match.status != 'waiting_for_player_2' or match.player_two_secret:
        raise HTTPException(status_code=409, detail='A started match cannot be cancelled')
    match.status = 'cancelled'
    match.finished_at = datetime.now(UTC)
    bump(match, activity='match_cancelled', player=1)
    db.commit()
    return {'cancelled': True}


@app.post('/v1/matches/{match_id}/forfeit')
def forfeit_match(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.query(DuelMatch).filter(DuelMatch.id == match_id).with_for_update().one_or_none()
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
        row.audio_expires_at = None
    match.status = f'forfeited_by_{player}'
    match.finished_at = datetime.now(UTC)
    bump(match, activity='match_finished', player=player)
    db.commit()
    try:
        delete_objects(keys)
    except Exception:
        logger.exception('Failed to delete forfeited duel audio; bucket lifecycle will retry cleanup')
    return match_view(db, match, player)


@app.post('/v1/matches/{match_id}/rematch')
def rematch(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id); player = match_player(match, x_player_token)
    if match.status != 'finished' and not match.status.startswith('forfeited_by_'):
        raise HTTPException(status_code=409, detail='Rematch is available only after the duel')
    if not match.player_two_secret:
        raise HTTPException(status_code=409, detail='Rematch requires two players')
    if match.rematch_requested_by in (None, player):
        if match.rematch_requested_by is None:
            match.rematch_requested_by = player
            bump(match, activity='rematch_requested', player=player)
            db.commit()
        return match_view(db, match, player)

    rounds = db.query(DuelRound).filter(DuelRound.match_id == match.id).with_for_update().all()
    keys = [key for row in rounds for key in (row.challenge_object_key, row.attempt_object_key) if key]
    for row in rounds:
        row.status = 'awaiting_phrase'
        row.phrase_text = None
        row.guess_text = None
        row.challenge_object_key = None
        row.attempt_object_key = None
        row.audio_expires_at = None
        row.score = None
        row.score_breakdown = {}
        row.challenge_idempotency_key = None
        row.attempt_idempotency_key = None
        row.challenger_result_seen = False
        row.responder_result_seen = False
    match.status = 'round_1'
    match.current_round = 1
    match.active_player = 1
    match.finished_at = None
    match.rematch_requested_by = None
    bump(match, activity='rematch_started', player=player)
    db.commit()
    try:
        delete_objects(keys)
    except Exception:
        logger.exception('Failed to delete previous duel audio during reset; bucket lifecycle will retry cleanup')
    return match_view(db, match, player)


@app.get('/v1/matches/{match_id}')
def get_match(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db)
    match = db.get(DuelMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail='Match not found')
    return match_view(db, match, match_player(match, x_player_token))


@app.post('/v1/matches/{match_id}/heartbeat')
def heartbeat(match_id: uuid.UUID, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id); player = match_player(match, x_player_token)
    if player == 1: match.player_one_last_seen_at = datetime.now(UTC)
    else: match.player_two_last_seen_at = datetime.now(UTC)
    bump(match)
    db.commit()
    return {'accepted': True, 'revision': match.revision}


ACTIVITY_BY_ROUND_STATUS = {
    'awaiting_phrase': {'writing_phrase'},
    'awaiting_challenge': {'recording_challenge', 'processing_challenge', 'listening_challenge', 'sending_challenge'},
    'awaiting_attempt': {'listening_challenge_by_opponent', 'recording_attempt', 'processing_attempt', 'sending_attempt'},
    'awaiting_guess': {'listening_restored_attempt', 'guessing_phrase'},
}


@app.post('/v1/matches/{match_id}/activity')
def update_activity(match_id: uuid.UUID, payload: ActivityUpdate, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id); player = match_player(match, x_player_token)
    if match.status not in ('round_1', 'round_2'):
        raise HTTPException(status_code=409, detail='Activity is not allowed now')
    if player != match.active_player:
        raise HTTPException(status_code=409, detail='Only the active player may publish activity')
    round_row = active_round(db, match.id, match.current_round)
    if payload.status not in ACTIVITY_BY_ROUND_STATUS.get(round_row.status, set()):
        raise HTTPException(status_code=409, detail='Activity does not match the active round state')
    bump(match, activity=payload.status, player=player); db.commit()
    return {'accepted': True, 'revision': match.revision}


@app.post('/v1/matches/{match_id}/rounds/{number}/phrase')
def submit_round_phrase(match_id: uuid.UUID, number: int, payload: RoundPhraseRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    row = active_round(db, match_id, number); player = match_player(match, x_player_token)
    if player != row.challenger: raise HTTPException(status_code=409, detail='Only the challenger can set the phrase')
    if row.phrase_text and row.status != 'awaiting_phrase': return match_view(db, match, player)
    ensure_current_turn(match, number, player)
    if row.status != 'awaiting_phrase': raise HTTPException(status_code=409, detail='Phrase is not allowed now')
    phrase = payload.phrase.strip()
    if not normalized_phrase(phrase): raise HTTPException(status_code=422, detail='Phrase must contain letters or numbers')
    row.phrase_text = phrase; row.status = 'awaiting_challenge'
    bump(match, activity='phrase_ready', player=player); db.commit()
    return match_view(db, match, player)


@app.post('/v1/matches/{match_id}/rounds/{number}/challenge-upload')
def challenge_upload(match_id: uuid.UUID, number: int, payload: AudioUploadRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    player = match_player(match, x_player_token); round_row = active_round(db, match_id, number)
    if player != round_row.challenger: raise HTTPException(status_code=409, detail='Challenge upload is not allowed now')
    ensure_current_turn(match, number, player)
    if round_row.status != 'awaiting_challenge': raise HTTPException(status_code=409, detail='Challenge upload is not allowed now')
    if round_row.challenge_object_key:
        url = storage_put_url(round_row.challenge_object_key, payload.content_type)
        round_row.audio_expires_at = datetime.now(UTC) + timedelta(seconds=settings.audio_ttl_seconds)
        bump(match, activity='sending_challenge', player=player); db.commit()
        return {'upload_url': url, 'expires_at': round_row.audio_expires_at}
    key = f'matches/{match_id}/round-{number}/challenge-{secrets.token_hex(12)}.wav'
    url = storage_put_url(key, payload.content_type)
    round_row.challenge_object_key = key; round_row.challenge_idempotency_key = payload.idempotency_key; round_row.audio_expires_at = datetime.now(UTC) + timedelta(seconds=settings.audio_ttl_seconds)
    bump(match, activity='sending_challenge', player=player)
    db.commit(); return {'upload_url': url, 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/challenge-ready')
def challenge_ready(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    round_row = active_round(db, match_id, number)
    player = match_player(match, x_player_token)
    if player != round_row.challenger or not round_row.challenge_object_key: raise HTTPException(status_code=409, detail='Challenge is not uploaded')
    if round_row.status == 'awaiting_attempt': return {'accepted': True, 'revision': match.revision}
    ensure_current_turn(match, number, player)
    if round_row.status != 'awaiting_challenge': raise HTTPException(status_code=409, detail='Challenge is not allowed now')
    round_row.status = 'awaiting_attempt'; match.active_player = round_row.responder; bump(match, activity='challenge_ready', player=player); db.commit(); return {'accepted': True, 'revision': match.revision}


@app.get('/v1/matches/{match_id}/rounds/{number}/challenge-audio')
def challenge_audio(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    player = match_player(match, x_player_token)
    if player != round_row.responder or round_row.status != 'awaiting_attempt' or not round_row.challenge_object_key: raise HTTPException(status_code=409, detail='Audio is not available')
    ensure_current_turn(match, number, player)
    ensure_audio_available(round_row)
    return {'download_url': storage_get_url(round_row.challenge_object_key), 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/attempt-upload')
def attempt_upload(match_id: uuid.UUID, number: int, payload: AudioUploadRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    round_row = active_round(db, match_id, number)
    player = match_player(match, x_player_token)
    if player != round_row.responder: raise HTTPException(status_code=409, detail='Attempt upload is not allowed now')
    ensure_current_turn(match, number, player)
    if round_row.status != 'awaiting_attempt': raise HTTPException(status_code=409, detail='Attempt upload is not allowed now')
    if round_row.attempt_object_key:
        url = storage_put_url(round_row.attempt_object_key, payload.content_type)
        round_row.audio_expires_at = datetime.now(UTC) + timedelta(seconds=settings.audio_ttl_seconds)
        bump(match, activity='sending_attempt', player=player); db.commit()
        return {'upload_url': url, 'expires_at': round_row.audio_expires_at}
    key = f'matches/{match_id}/round-{number}/attempt-{secrets.token_hex(12)}.wav'
    url = storage_put_url(key, payload.content_type)
    round_row.attempt_object_key = key
    round_row.attempt_idempotency_key = payload.idempotency_key
    round_row.audio_expires_at = datetime.now(UTC) + timedelta(seconds=settings.audio_ttl_seconds)
    bump(match, activity='sending_attempt', player=round_row.responder)
    db.commit(); return {'upload_url': url, 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/attempt-ready')
def attempt_ready(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    round_row = active_round(db, match_id, number)
    player = match_player(match, x_player_token)
    if player != round_row.responder or not round_row.attempt_object_key: raise HTTPException(status_code=409, detail='Attempt is not uploaded')
    if round_row.status == 'awaiting_guess': return {'accepted': True, 'revision': match.revision}
    ensure_current_turn(match, number, player)
    if round_row.status != 'awaiting_attempt': raise HTTPException(status_code=409, detail='Attempt is not allowed now')
    round_row.status = 'awaiting_guess'; match.active_player = round_row.responder; bump(match, activity='guessing_phrase', player=round_row.responder); db.commit(); return {'accepted': True, 'revision': match.revision}


@app.get('/v1/matches/{match_id}/rounds/{number}/attempt-audio')
def attempt_audio(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = db.get(DuelMatch, match_id)
    if match is None: raise HTTPException(status_code=404, detail='Match not found')
    round_row = active_round(db, match_id, number)
    player = match_player(match, x_player_token)
    if player not in (round_row.challenger, round_row.responder): raise HTTPException(status_code=403, detail='Attempt is not available')
    if round_row.status not in ('awaiting_guess', 'complete') or not round_row.attempt_object_key: raise HTTPException(status_code=409, detail='Attempt is not available')
    ensure_audio_available(round_row)
    return {'download_url': storage_get_url(round_row.attempt_object_key), 'expires_at': round_row.audio_expires_at}


@app.post('/v1/matches/{match_id}/rounds/{number}/guess')
def submit_round_guess(match_id: uuid.UUID, number: int, payload: RoundGuessRequest, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    row = active_round(db, match_id, number)
    player = match_player(match, x_player_token)
    if player != row.responder: raise HTTPException(status_code=409, detail='Only the responder can submit a guess')
    if row.status == 'complete': return match_view(db, match, player)
    ensure_current_turn(match, number, player)
    if row.status != 'awaiting_guess' or not row.phrase_text: raise HTTPException(status_code=409, detail='Guess is not allowed now')
    guess = payload.guess.strip()
    if not normalized_phrase(guess): raise HTTPException(status_code=422, detail='Guess must contain letters or numbers')
    row.guess_text = guess; row.score = phrase_score(row.phrase_text, guess)
    row.score_breakdown = {'text_similarity': row.score / 100}; row.status = 'complete'
    if number == 1:
        match.status = 'round_2'; match.current_round = 2; match.active_player = 2; bump(match, activity='switching_roles', player=2)
    else:
        match.status = 'finished'; match.finished_at = datetime.now(UTC); bump(match, activity='match_finished', player=None)
    keys = [row.challenge_object_key] if row.challenge_object_key else []
    row.challenge_object_key = None; db.commit()
    try: delete_objects(keys)
    except Exception: logger.exception('Failed to delete completed duel audio; bucket lifecycle will retry cleanup')
    return match_view(db, match, match_player(match, x_player_token))


@app.post('/v1/matches/{match_id}/rounds/{number}/result-seen')
def mark_round_result_seen(match_id: uuid.UUID, number: int, x_player_token: str | None = Header(None), db: Session | None = Depends(get_db)) -> dict:
    db = require_database(db); match = locked_match(db, match_id)
    row = active_round(db, match_id, number); player = match_player(match, x_player_token)
    if row.status != 'complete': raise HTTPException(status_code=409, detail='Round result is not available')
    attribute = 'challenger_result_seen' if player == row.challenger else 'responder_result_seen'
    if not getattr(row, attribute):
        setattr(row, attribute, True); bump(match, activity='round_result_seen', player=player)
    key = None
    if row.challenger_result_seen and row.responder_result_seen and row.attempt_object_key:
        key = row.attempt_object_key; row.attempt_object_key = None; row.audio_expires_at = None
    db.commit()
    if key:
        try: delete_objects([key])
        except Exception: logger.exception('Failed to delete reviewed attempt audio; bucket lifecycle will retry cleanup')
    return match_view(db, match, player)


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


def require_token(provided: str | None, expected: str | None) -> None:
    if not expected or not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail='Invalid analytics token')


@app.post('/v1/bot/events', status_code=202)
def save_bot_event(
    payload: EventCreate,
    x_analytics_token: str | None = Header(default=None),
    db: Session | None = Depends(get_db),
) -> dict:
    require_token(x_analytics_token, settings.analytics_ingest_token)
    if db is not None:
        values = payload.model_dump()
        values['source'] = 'telegram_bot'
        db.add(AnalyticsEvent(**values))
        db.commit()
    return {'accepted': True}


@app.get('/v1/admin/analytics')
def analytics_summary(
    days: int = Query(default=30, ge=1, le=366),
    authorization: str | None = Header(default=None),
    db: Session | None = Depends(get_db),
) -> dict:
    provided = authorization.removeprefix('Bearer ').strip() if authorization else None
    require_token(provided, settings.analytics_admin_token)
    db = require_database(db)
    since = datetime.now(UTC) - timedelta(days=days - 1)
    query = db.query(AnalyticsEvent).filter(AnalyticsEvent.created_at >= since)
    counts = dict(query.with_entities(AnalyticsEvent.event_name, func.count(AnalyticsEvent.id)).group_by(AnalyticsEvent.event_name).all())
    sessions = db.query(func.count(GameSession.id)).filter(GameSession.created_at >= since).scalar() or 0
    top_elements = [
        {'element': element, 'clicks': count}
        for element, count in query.filter(AnalyticsEvent.action == 'click', AnalyticsEvent.element.is_not(None)).with_entities(
            AnalyticsEvent.element, func.count(AnalyticsEvent.id)
        ).group_by(AnalyticsEvent.element).order_by(func.count(AnalyticsEvent.id).desc()).limit(20).all()
    ]
    daily_rows = query.with_entities(
        func.date(AnalyticsEvent.created_at), AnalyticsEvent.event_name, func.count(AnalyticsEvent.id)
    ).group_by(func.date(AnalyticsEvent.created_at), AnalyticsEvent.event_name).order_by(func.date(AnalyticsEvent.created_at)).all()
    daily: dict[str, dict[str, int]] = {}
    for day, event_name, count in daily_rows:
        daily.setdefault(str(day), {})[event_name] = count
    session_daily_rows = db.query(
        func.date(GameSession.created_at), func.count(GameSession.id)
    ).filter(GameSession.created_at >= since).group_by(func.date(GameSession.created_at)).all()
    for day, count in session_daily_rows:
        daily.setdefault(str(day), {})['sessions'] = count
    metrics = {
        'sessions': sessions,
        'clicks': counts.get('element_clicked', 0),
        'game_starts': counts.get('game_started', 0),
        'game_completions': counts.get('game_completed', 0),
        'local_duels': counts.get('local_duel_started', 0),
        'online_duels': counts.get('online_duel_started', 0),
        'easysong_clicks': counts.get('easysong_clicked', 0),
        'telegram_banner_clicks': counts.get('telegram_banner_clicked', 0),
        'bot_starts': counts.get('bot_started', 0),
        'bot_check_clicks': counts.get('bot_check_clicked', 0),
        'bot_game_opens': counts.get('bot_game_opened', 0),
    }
    return {'period_days': days, 'totals': metrics, 'events': counts, 'top_elements': top_elements, 'daily': daily}


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
