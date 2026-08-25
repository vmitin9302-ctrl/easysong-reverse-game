const apiBase = (process.env.QA_API_URL || 'https://bba4u5rl3fimpjhbrrqo.containers.yandexcloud.net').replace(/\/$/, '');
const timeoutMs = 20_000;

function wav(frequency) {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + sampleCount * 2, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) bytes.writeInt16LE(Math.round(12_000 * Math.sin(2 * Math.PI * frequency * index / sampleRate)), 44 + index * 2);
  return bytes;
}

async function request(url, { method = 'GET', token, json, body, contentType } = {}) {
  const response = await fetch(url.startsWith('http') ? url : `${apiBase}${url}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(token ? { 'X-Player-Token': token } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  return response;
}

async function json(path, options) {
  const response = await request(path, options);
  if (!response.ok) throw new Error(`${options?.method || 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function uploadAudio(matchId, round, kind, token, bytes) {
  const idempotencyKey = `qa-${matchId}-${round}-${kind}`;
  const payload = { method: 'POST', token, json: { content_type: 'audio/wav', idempotency_key: idempotencyKey } };
  const slot = await json(`/v1/matches/${matchId}/rounds/${round}/${kind}-upload`, payload);
  await json(`/v1/matches/${matchId}/rounds/${round}/${kind}-upload`, payload);
  const uploaded = await request(slot.upload_url, { method: 'PUT', body: bytes, contentType: 'audio/wav' });
  if (!uploaded.ok) throw new Error(`PUT ${kind}: ${uploaded.status}`);
  await json(`/v1/matches/${matchId}/rounds/${round}/${kind}-ready`, { method: 'POST', token, json: {} });
  await json(`/v1/matches/${matchId}/rounds/${round}/${kind}-ready`, { method: 'POST', token, json: {} });
  return uploaded.status;
}

async function downloadAudio(matchId, round, kind, token) {
  const slot = await json(`/v1/matches/${matchId}/rounds/${round}/${kind}-audio`, { token });
  const response = await request(slot.download_url);
  if (!response.ok) throw new Error(`GET ${kind}: ${response.status}`);
  return { bytes: (await response.arrayBuffer()).byteLength, url: slot.download_url };
}

async function run() {
  const clipA = wav(440), clipB = wav(660);
  const match = await json('/v1/matches', { method: 'POST', json: { session_id: null } });
  const playerTwo = await json(`/v1/matches/join/${match.invite_token}`, { method: 'POST', json: {} });
  const resumedPlayerTwo = await json(`/v1/matches/join/${match.invite_token}`, { method: 'POST', json: { participant_token: playerTwo.player_token } });
  const thirdPlayerStatus = (await request(`/v1/matches/join/${match.invite_token}`, { method: 'POST', json: {} })).status;
  await json(`/v1/matches/${match.id}/heartbeat`, { method: 'POST', token: playerTwo.player_token, json: {} });
  await json(`/v1/matches/${match.id}/activity`, { method: 'POST', token: match.player_token, json: { status: 'writing_phrase' } });
  const activitySeen = await json(`/v1/matches/${match.id}`, { token: playerTwo.player_token });
  const round1Phrase = 'Ёжик, иди домой!';
  await json(`/v1/matches/${match.id}/rounds/1/phrase`, { method: 'POST', token: match.player_token, json: { phrase: round1Phrase } });
  const hiddenRound1Phrase = (await json(`/v1/matches/${match.id}`, { token: playerTwo.player_token })).rounds[0].phrase;

  const round1ChallengePut = await uploadAudio(match.id, 1, 'challenge', match.player_token, clipA);
  const round1ChallengeRewrite = (await request(`/v1/matches/${match.id}/rounds/1/challenge-upload`, { method: 'POST', token: match.player_token, json: { content_type: 'audio/wav', idempotency_key: 'qa-rewrite-challenge' } })).status;
  const round1Challenge = await downloadAudio(match.id, 1, 'challenge', playerTwo.player_token);
  const round1AttemptPut = await uploadAudio(match.id, 1, 'attempt', playerTwo.player_token, clipB);
  const round1AttemptRewrite = (await request(`/v1/matches/${match.id}/rounds/1/attempt-upload`, { method: 'POST', token: playerTwo.player_token, json: { content_type: 'audio/wav', idempotency_key: 'qa-rewrite-attempt' } })).status;
  const round1Attempt = await downloadAudio(match.id, 1, 'attempt', playerTwo.player_token);
  const afterRound1 = await json(`/v1/matches/${match.id}/rounds/1/guess`, { method: 'POST', token: playerTwo.player_token, json: { guess: 'ежик иди домой' } });
  const afterRound1Duplicate = await json(`/v1/matches/${match.id}/rounds/1/guess`, { method: 'POST', token: playerTwo.player_token, json: { guess: 'ежик иди домой' } });
  const round1Deleted = (await request(round1Attempt.url)).status;

  const round2Phrase = 'Сегодня светит солнце';
  await json(`/v1/matches/${match.id}/rounds/2/phrase`, { method: 'POST', token: playerTwo.player_token, json: { phrase: round2Phrase } });
  const round2ChallengePut = await uploadAudio(match.id, 2, 'challenge', playerTwo.player_token, clipB);
  const round2Challenge = await downloadAudio(match.id, 2, 'challenge', match.player_token);
  const round2AttemptPut = await uploadAudio(match.id, 2, 'attempt', match.player_token, clipA);
  const round2Attempt = await downloadAudio(match.id, 2, 'attempt', match.player_token);
  const afterRound2 = await json(`/v1/matches/${match.id}/rounds/2/guess`, { method: 'POST', token: match.player_token, json: { guess: 'сегодня' } });
  const playerOneFinal = await json(`/v1/matches/${match.id}`, { token: match.player_token });
  const playerTwoFinal = await json(`/v1/matches/${match.id}`, { token: playerTwo.player_token });
  const round2Deleted = (await request(round2Challenge.url)).status;

  const raceMatch = await json('/v1/matches', { method: 'POST', json: { session_id: null } });
  const raceResponses = await Promise.all([
    request(`/v1/matches/join/${raceMatch.invite_token}`, { method: 'POST', json: {} }),
    request(`/v1/matches/join/${raceMatch.invite_token}`, { method: 'POST', json: {} }),
  ]);
  const raceStatuses = raceResponses.map((response) => response.status).sort();
  await json(`/v1/matches/${raceMatch.id}/forfeit`, { method: 'POST', token: raceMatch.player_token, json: {} });

  const empty = await json('/v1/matches', { method: 'POST', json: { session_id: null } });
  const cancelled = await json(`/v1/matches/${empty.id}/cancel`, { method: 'POST', token: empty.player_token, json: {} });
  const cancelledInviteJoin = (await request(`/v1/matches/join/${empty.invite_token}`, { method: 'POST', json: {} })).status;

  const surrenderMatch = await json('/v1/matches', { method: 'POST', json: { session_id: null } });
  const surrenderPlayerTwo = await json(`/v1/matches/join/${surrenderMatch.invite_token}`, { method: 'POST', json: {} });
  await json(`/v1/matches/${surrenderMatch.id}/forfeit`, { method: 'POST', token: surrenderPlayerTwo.player_token, json: {} });
  const creatorAfterForfeit = await json(`/v1/matches/${surrenderMatch.id}`, { token: surrenderMatch.player_token });

  const expected = (condition, message) => { if (!condition) throw new Error(`QA assertion failed: ${message}`); };
  expected(resumedPlayerTwo.player === 2, 'resume must keep player 2 slot');
  expected(thirdPlayerStatus === 409, 'third player must be rejected');
  expected(activitySeen.activity_status === 'writing_phrase', 'activity must reach the waiting player');
  expected(activitySeen.player_two_last_seen_at, 'heartbeat must update player presence');
  expected(hiddenRound1Phrase === null, 'secret phrase must stay hidden from the responder before the guess');
  expected(JSON.stringify(raceStatuses) === JSON.stringify([200, 409]), 'concurrent join must yield one 200 and one 409');
  expected(round1Challenge.bytes > 44 && round1Attempt.bytes > 44 && round2Challenge.bytes > 44 && round2Attempt.bytes > 44, 'uploaded audio must be downloadable and non-empty');
  expected(round1ChallengeRewrite === 409 && round1AttemptRewrite === 409, 'ready audio must not be replaceable');
  expected(afterRound1.status === 'round_2' && afterRound1.scores[1] === 100 && afterRound1Duplicate.revision === afterRound1.revision, 'guess finalize must score normalized text and be idempotent');
  expected(afterRound2.status === 'finished', 'round 2 must finish the match');
  expected(playerOneFinal.scores[1] === 100 && playerOneFinal.scores[0] < 100, 'text scores must map to player slots');
  expected(JSON.stringify(playerTwoFinal.scores) === JSON.stringify(playerOneFinal.scores), 'both players must see identical scores');
  expected(playerOneFinal.winner === 2 && playerTwoFinal.winner === 2, 'both players must see the same winner');
  expected(playerOneFinal.rounds[0].phrase === round1Phrase && playerTwoFinal.rounds[1].phrase === round2Phrase, 'completed phrases must be revealed to both players');
  expected([403, 404].includes(round1Deleted) && [403, 404].includes(round2Deleted), 'temporary audio must be deleted');
  expected(cancelled.cancelled && cancelledInviteJoin === 410, 'cancelled room must reject join');
  expected(creatorAfterForfeit.forfeited_by === 2, 'forfeit must be visible to the opponent');

  return {
    connection: { resumedSlot: resumedPlayerTwo.player, thirdPlayerStatus, activitySeen: activitySeen.activity_status, raceStatuses },
    round1: { challengePut: round1ChallengePut, challengeBytes: round1Challenge.bytes, challengeRewrite: round1ChallengeRewrite, attemptPut: round1AttemptPut, attemptBytes: round1Attempt.bytes, attemptRewrite: round1AttemptRewrite, nextState: afterRound1.status, duplicateRevision: afterRound1Duplicate.revision, deletedAudioStatus: round1Deleted },
    round2: { challengePut: round2ChallengePut, challengeBytes: round2Challenge.bytes, attemptPut: round2AttemptPut, attemptBytes: round2Attempt.bytes, finalState: afterRound2.status, deletedAudioStatus: round2Deleted },
    final: { playerOneScores: playerOneFinal.scores, playerTwoScores: playerTwoFinal.scores, playerOneWinner: playerOneFinal.winner, playerTwoWinner: playerTwoFinal.winner, phrasesRevealed: playerOneFinal.rounds.map((round) => round.phrase) },
    cancellation: { cancelled: cancelled.cancelled, inviteJoinStatus: cancelledInviteJoin },
    forfeit: { creatorSeesPlayer: creatorAfterForfeit.forfeited_by },
  };
}

try {
  console.log(JSON.stringify(await run(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
