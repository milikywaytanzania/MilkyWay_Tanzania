import { postShareResponse } from '../../api/_lib/post-share.js';

export default (request, context) => postShareResponse(request.url, context.params.postId, request.headers.get('user-agent') || '');

export const config = { path: '/share/:postId' };
