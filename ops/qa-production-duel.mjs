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
  const slot = await json(`/v1/matches/${matchId}/rounds/${round}/${kind}-upload`, { method: 'POST', token, json: { content_type: 'audio/wav' } });
  const uploaded = await request(slot.upload_url, { method: 'PUT', body: bytes, contentType: 'audio/wav' });
  if (!uploaded.ok) throw new Error(`PUT ${kind}: ${uploaded.status}`);
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

  const round1ChallengePut = await uploadAudio(match.id, 1, 'challenge', match.player_token, clipA);
  const round1Challenge = await downloadAudio(match.id, 1, 'challenge', playerTwo.player_token);
  const round1AttemptPut = await uploadAudio(match.id, 1, 'attempt', playerTwo.player_token, clipB);
  const round1Attempt = await downloadAudio(match.id, 1, 'attempt', match.player_token);
  const afterRound1 = await json(`/v1/matches/${match.id}/rounds/1/score`, { method: 'POST', token: match.player_token, json: { score: 73, acoustic_similarity: 0.73, rhythm_similarity: 0.72, duration_similarity: 1 } });
  const round1Deleted = (await request(round1Attempt.url)).status;

  const round2ChallengePut = await uploadAudio(match.id, 2, 'challenge', playerTwo.player_token, clipB);
  const round2Challenge = await downloadAudio(match.id, 2, 'challenge', match.player_token);
  const round2AttemptPut = await uploadAudio(match.id, 2, 'attempt', match.player_token, clipA);
  const round2Attempt = await downloadAudio(match.id, 2, 'attempt', playerTwo.player_token);
  const afterRound2 = await json(`/v1/matches/${match.id}/rounds/2/score`, { method: 'POST', token: playerTwo.player_token, json: { score: 81, acoustic_similarity: 0.81, rhythm_similarity: 0.8, duration_similarity: 1 } });
  const playerOneFinal = await json(`/v1/matches/${match.id}`, { token: match.player_token });
  const playerTwoFinal = await json(`/v1/matches/${match.id}`, { token: playerTwo.player_token });
  const round2Deleted = (await request(round2Challenge.url)).status;

  const empty = await json('/v1/matches', { method: 'POST', json: { session_id: null } });
  const cancelled = await json(`/v1/matches/${empty.id}/cancel`, { method: 'POST', token: empty.player_token, json: {} });
  const cancelledInviteJoin = (await request(`/v1/matches/join/${empty.invite_token}`, { method: 'POST', json: {} })).status;

  const surrenderMatch = await json('/v1/matches', { method: 'POST', json: { session_id: null } });
  const surrenderPlayerTwo = await json(`/v1/matches/join/${surrenderMatch.invite_token}`, { method: 'POST', json: {} });
  await json(`/v1/matches/${surrenderMatch.id}/forfeit`, { method: 'POST', token: surrenderPlayerTwo.player_token, json: {} });
  const creatorAfterForfeit = await json(`/v1/matches/${surrenderMatch.id}`, { token: surrenderMatch.player_token });

  return {
    round1: { challengePut: round1ChallengePut, challengeBytes: round1Challenge.bytes, attemptPut: round1AttemptPut, attemptBytes: round1Attempt.bytes, nextState: afterRound1.status, deletedAudioStatus: round1Deleted },
    round2: { challengePut: round2ChallengePut, challengeBytes: round2Challenge.bytes, attemptPut: round2AttemptPut, attemptBytes: round2Attempt.bytes, finalState: afterRound2.status, deletedAudioStatus: round2Deleted },
    final: { playerOneScores: playerOneFinal.rounds.map((round) => round.score), playerTwoScores: playerTwoFinal.rounds.map((round) => round.score) },
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
