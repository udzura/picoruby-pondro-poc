const messages = {
  en: {
    title: 'Pondro · AI chat', back: '← Playground', heading: 'A room for everyone.',
    intro: 'Humans and AI, in the same conversation. Bring one personality to many rooms.',
    language: 'Language', mode: 'AI chat', mock: 'Local demo · mock AI', live: 'Workers AI',
    join: '01 / Join a room', roomId: 'Room ID', yourName: 'Your name', connect: 'Connect', leave: 'Leave',
    roomHint: 'Open another tab with the same Room ID to chat together.',
    personalityStep: '02 / Give AI a personality', aiId: 'AI ID', aiName: 'AI name', personality: 'Personality prompt',
    createAI: 'Load or create AI', invite: 'Invite AI to this room',
    adminOnly: 'AI creation and invitations are available to administrators.',
    personaHint: 'The first prompt is saved for this AI ID. Use a new ID for another personality.',
    chatRoom: 'Chat room', conversation: 'The conversation', chooseRoom: 'Choose your room', participants: 'AI participants',
    participantsHint: 'Invite an AI, or start a conversation with other people.',
    noAI: 'No AI participants yet. Invite one from the left.',
    noAIGuest: 'No AI participants yet. An administrator can invite one.',
    hello: 'Say hello.', emptyHint: 'Connect to a room, create an AI, and invite it to join you.',
    emptyGuest: 'Connect to a room to chat with the people and AI already there.',
    message: 'Message', messagePlaceholder: 'Write to everyone in the room…', send: 'Send ↗',
    footer: 'AI replies stream into the chat. The last 50 messages survive reconnects.',
    connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected',
    remove: 'Remove', removeLabel: 'Remove {name} from this room',
    thinking: 'Thinking…', replying: 'replying', interrupted: 'interrupted',
    joined: 'You joined the room. Say hello or invite an AI.', joinedGuest: 'You joined the room. Say hello to everyone.',
    departed: '{name} left the room.',
    invalidConnection: 'Enter a Room ID and a name of at most 128 bytes.',
    unreadable: 'Could not read a server message.', connectionFailed: 'Connection failed. Check that the example2 server is running.',
    invalidPersona: 'Name: at most 128 bytes. Prompt: at most 4096 bytes.',
    loaded: 'Loaded the saved personality.', saved: 'Personality saved.',
    rooms: 'Rooms: {rooms}.', readyToJoin: 'Ready to join a room.', reuse: 'Reuse this AI ID in another room.',
    messageTooLong: 'Message must be at most 2000 bytes.', frameTooLong: 'Encoded message is too large. Please shorten it.',
    error: 'Error: {detail}', aiError: 'AI reply failed: {detail}'
  },
  ja: {
    title: 'Pondro · AIチャット', back: '← プレイグラウンド', heading: 'みんなで話せるチャットルーム。',
    intro: '人間もAIも、同じ会話に。同じ性格のAIを、いろいろなルームへ招待できます。',
    language: '表示言語', mode: 'AIチャット', mock: 'ローカルデモ · 模擬AI', live: 'Workers AI',
    join: '01 / ルームに参加', roomId: 'ルームID', yourName: 'あなたの名前', connect: '接続', leave: '退出',
    roomHint: '同じルームIDを別のタブで開くと、一緒にチャットできます。',
    personalityStep: '02 / AIの性格を設定', aiId: 'AI ID', aiName: 'AIの名前', personality: '性格のプロンプト',
    createAI: 'AIを読み込む・作成する', invite: 'このルームにAIを追加',
    adminOnly: 'AIの作成・追加は管理者のみ利用できます。',
    personaHint: 'AI IDごとに最初の性格を保存します。別の性格には新しいIDを使ってください。',
    chatRoom: 'チャットルーム', conversation: '会話', chooseRoom: 'ルームを選んでください', participants: '参加中のAI',
    participantsHint: 'AIを追加するか、ほかの参加者と会話しましょう。',
    noAI: '参加中のAIはいません。左の設定から追加できます。',
    noAIGuest: '参加中のAIはいません。管理者がAIを追加すると会話できます。',
    hello: '話しかけてみましょう。', emptyHint: 'ルームに接続し、AIを作成して追加しましょう。',
    emptyGuest: 'ルームに接続すると、参加中の人やAIと会話できます。',
    message: 'メッセージ', messagePlaceholder: 'ルームのみんなに話しかけましょう…', send: '送信 ↗',
    footer: 'AIの返答は少しずつ表示されます。最新50件の会話は再接続しても残ります。',
    connecting: '接続中…', connected: '接続済み', disconnected: '未接続',
    remove: '退出させる', removeLabel: '{name}をこのルームから退出させる',
    thinking: '考えています…', replying: '返答中', interrupted: '中断',
    joined: 'ルームに参加しました。話しかけるか、AIを追加しましょう。', joinedGuest: 'ルームに参加しました。みんなに話しかけてみましょう。',
    departed: '{name}が退出しました。',
    invalidConnection: 'ルームIDと名前を入力してください。名前は128バイトまでです。',
    unreadable: 'サーバーからのメッセージを読み取れませんでした。', connectionFailed: '接続に失敗しました。example2のサーバーが起動しているか確認してください。',
    invalidPersona: '名前は128バイト、プロンプトは4096バイトまでです。',
    loaded: '保存済みの性格を読み込みました。', saved: '性格を保存しました。',
    rooms: '参加ルーム: {rooms}。', readyToJoin: 'ルームに追加できます。', reuse: '別のルームでも同じAI IDを使えます。',
    messageTooLong: 'メッセージは2000バイトまでです。', frameTooLong: '送信データが大きすぎます。メッセージを短くしてください。',
    error: 'エラー: {detail}', aiError: 'AIの返答に失敗しました: {detail}'
  }
};

let language = navigator.language.startsWith('ja') ? 'ja' : 'en';
try {
  const saved = localStorage.getItem('pondro-example2-language');
  if (Object.hasOwn(messages, saved)) language = saved;
} catch { /* The UI also works when browser storage is unavailable. */ }

export function t(key, params = {}) {
  return messages[language][key].replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
}

export function localize(node, key, params = {}) {
  node.dataset.i18n = key;
  node.dataset.i18nParams = JSON.stringify(params);
  node.textContent = t(key, params);
  return node;
}

export function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('title');
  document.getElementById('language').value = language;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, JSON.parse(node.dataset.i18nParams || '{}'));
  }
  for (const [attribute, data] of [['placeholder', 'i18nPlaceholder'], ['aria-label', 'i18nAria']]) {
    for (const node of document.querySelectorAll(`[data-${data.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}]`)) {
      node.setAttribute(attribute, t(node.dataset[data], JSON.parse(node.dataset.i18nParams || '{}')));
    }
  }
  for (const node of document.querySelectorAll('.sender')) {
    node.dataset.replying = t('replying');
    node.dataset.interrupted = t('interrupted');
  }
}

export function setLanguage(value) {
  if (!Object.hasOwn(messages, value)) return;
  language = value;
  try { localStorage.setItem('pondro-example2-language', value); } catch { /* Optional preference. */ }
  applyLanguage();
}
