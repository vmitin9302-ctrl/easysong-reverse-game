import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import AnalyticsEvent, GameResult, GameSession, OutboundClick, ShareLink
from .settings import settings
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
    allow_headers=['Content-Type', 'Authorization'],
)


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
