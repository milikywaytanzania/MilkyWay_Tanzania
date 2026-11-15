(function () {
  const artistId = new URLSearchParams(location.search).get('artist');
  const threadKey = artistId ? `masiyatunda_arts_thread_${artistId}` : 'masiyatunda_arts_thread';
  const threadId = localStorage.getItem(threadKey) || (crypto.randomUUID && crypto.randomUUID()) || `t-${Date.now()}`;
  localStorage.setItem(threadKey, threadId);
  const name = document.getElementById('chatName');
  const phone = document.getElementById('chatPhone');
  const input = document.getElementById('chatInput');
  const messages = document.getElementById('chatMsgs');
  const status = document.getElementById('status');
  const unreadBadge = document.getElementById('sanaaUnread');
  name.value = localStorage.getItem('masiya_chat_name') || '';
  phone.value = localStorage.getItem('masiya_chat_phone') || '';

  async function loadMessages() {
    const result = await sb.from('chat_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true });
    if (result.error) {
      status.textContent = result.error.message;
      return;
    }
    const rows = result.data || [];
    const unread = rows.filter(item => !item.is_from_admin && !item.is_read).length;
    if (unreadBadge) {
      unreadBadge.textContent = unread;
      unreadBadge.style.display = unread ? 'inline-flex' : 'none';
    }
    const bubbles = rows.map(item => {
      const bubble = document.createElement('div');
      bubble.className = `bubble ${item.is_from_admin ? 'them' : 'me'}`;
      bubble.append(document.createTextNode(item.message || ''));
      const metadata = document.createElement('small');
      metadata.textContent = `${item.is_from_admin ? 'Masiyatunda Admin' : 'Wewe'} · ${item.created_at ? new Date(item.created_at).toLocaleString() : ''}`;
      bubble.append(metadata);
      return bubble;
    });
    if (bubbles.length) messages.replaceChildren(...bubbles);
    else {
      const empty = document.createElement('p');
      empty.style.color = '#64748b';
      empty.textContent = 'Anza mazungumzo na timu yetu.';
      messages.replaceChildren(empty);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  document.querySelectorAll('[data-q]').forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.q;
    input.focus();
  }));
  document.getElementById('send').addEventListener('click', async () => {
    const displayName = name.value.trim();
    const phoneNumber = phone.value.trim();
    const message = input.value.trim();
    if (!message) { status.textContent = 'Andika ujumbe.'; return; }
    if (!displayName && !phoneNumber) { status.textContent = 'Weka jina au simu.'; return; }
    localStorage.setItem('masiya_chat_name', displayName);
    localStorage.setItem('masiya_chat_phone', phoneNumber);
    status.textContent = 'Inatuma...';
    const result = await sb.from('chat_messages').insert({
      thread_id: threadId,
      name: displayName || null,
      phone: phoneNumber || null,
      message,
      is_from_admin: false,
      is_read: false,
      language: localStorage.getItem('masiyatunda_lang') || 'sw',
      context: 'sanaa',
      artist_id: artistId || null,
    });
    if (result.error) { status.textContent = result.error.message; return; }
    input.value = '';
    status.textContent = 'Ujumbe umetumwa kwa Admin.';
    await loadMessages();
  });
  loadMessages();
  setInterval(loadMessages, 7000);
})();
