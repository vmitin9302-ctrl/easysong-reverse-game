import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, SmallInteger, String, Text, Uuid, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class GameSession(Base):
    __tablename__ = 'game_sessions'

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source: Mapped[str] = mapped_column(String(32), default='direct')
    campaign: Mapped[str | None] = mapped_column(String(128), nullable=True)
    medium: Mapped[str | None] = mapped_column(String(128), nullable=True)
    referral_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    platform: Mapped[str] = mapped_column(String(32), default='web')
    status: Mapped[str] = mapped_column(String(32), default='started')


class GameResult(Base):
    __tablename__ = 'game_results'

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('game_sessions.id'), index=True)
    score: Mapped[int] = mapped_column(SmallInteger)
    original_duration_ms: Mapped[int] = mapped_column(Integer)
    attempt_duration_ms: Mapped[int] = mapped_column(Integer)
    acoustic_similarity: Mapped[float] = mapped_column(Float)
    rhythm_similarity: Mapped[float] = mapped_column(Float)
    duration_similarity: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AnalyticsEvent(Base):
    __tablename__ = 'analytics_events'

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    event_name: Mapped[str] = mapped_column(String(96), index=True)
    properties: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ShareLink(Base):
    __tablename__ = 'share_links'

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    token: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    creator_session_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('game_sessions.id'))
    score: Mapped[int] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OutboundClick(Base):
    __tablename__ = 'outbound_clicks'

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    destination: Mapped[str] = mapped_column(String(64), default='easysong')
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    campaign: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DuelMatch(Base):
    __tablename__ = 'duel_matches'

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('game_sessions.id'), nullable=True)
    invite_token: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    player_one_secret: Mapped[str] = mapped_column(String(96))
    player_two_secret: Mapped[str | None] = mapped_column(String(96), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default='waiting_for_player_2', index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DuelRound(Base):
    __tablename__ = 'duel_rounds'
    __table_args__ = (UniqueConstraint('match_id', 'round_number'),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    match_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('duel_matches.id'), index=True)
    round_number: Mapped[int] = mapped_column(SmallInteger)
    challenger: Mapped[int] = mapped_column(SmallInteger)
    responder: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[str] = mapped_column(String(32), default='awaiting_challenge')
    challenge_object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    score: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    score_breakdown: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
