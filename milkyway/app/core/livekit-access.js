function decodeClaims(token) {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('The LiveKit token is invalid.');
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=')), char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function serverAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The LiveKit server URL is invalid.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('The LiveKit server URL is invalid.');
  }
  return url;
}

/** Validates the room grant and optionally pins a token response to the current LiveKit server. */
export function assertRoomAccess(access, roomName, expectedServerUrl = '') {
  if (typeof access?.token !== 'string' || access.token.split('.').length !== 3) {
    throw new Error('The LiveKit token is invalid.');
  }
  const serverUrl = serverAddress(access.serverUrl);
  if (access.roomName && access.roomName !== roomName) throw new Error('The LiveKit token is for a different room.');
  const claims = decodeClaims(access.token);
  if (claims.video?.room !== roomName || claims.video?.roomJoin !== true) {
    throw new Error('The LiveKit token is for a different room.');
  }
  if (expectedServerUrl && serverAddress(expectedServerUrl).origin !== serverUrl.origin) {
    throw new Error('The LiveKit fallback points to a different server; refusing to join a separate room.');
  }
  return access;
}
