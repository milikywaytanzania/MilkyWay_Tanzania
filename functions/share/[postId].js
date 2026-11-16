import { postShareResponse } from '../../api/_lib/post-share.js';

export const onRequest = ({ request, params }) => postShareResponse(request.url, params.postId, request.headers.get('user-agent') || '');
