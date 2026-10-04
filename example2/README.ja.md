# Example 2: AIと人間の共有チャット

[English](README.md)

AI IDごとに性格を保存し、同じAIを複数Roomへ招待できるWebSocketチャットです。
人間も同じRoomに参加します。会話履歴はRoomごとに独立し、JSのUIは`/example2/`です。

## 起動

ルートで`npm ci`と`npm run setup`を済ませた後、起動します。

```sh
npm run build
npm run dev:example2:mock
```

AIを作成・追加する場合は<http://localhost:8787/example2/?admin=1>を開きます。mock版は性格と最新の発言を使った
確認用の返答で、モデルの推論ではありません。DOもローカルで動き、推論通信はありません。
UIにもmockと表示します。

画面の表示言語から日本語・英語を切り替えられます。接続、発言、性格のプロンプトは
維持されます。選択をブラウザーに保存し、初回はブラウザーの言語に合わせます。
デモ参加者には`/example2/`を共有してください。`admin=1`がないとAIの設定欄と
作成・追加ボタンが無効になり、ルームへの接続と会話は通常どおり利用できます。
この切り替えは画面だけの制限です。サーバー側の認証ではなく、APIとAIの退出操作は
変更していません。

管理者画面の「データをすべてクリア」は、確認後に、このWorkerの全Pondroオブジェクト
（AI、一覧、全Room、会話履歴、Counterなど）の保存データを削除して接続を閉じます。
人間だけのRoomも対象です。進行中のイベントの完了を待ってから削除し、その後は
同じIDで作り直せます。表示言語とCloudflareの認証情報は保持します。
POST `/api/demo/reset?admin=1`がデモ用の初期化APIです。クエリは認証ではありません。
`DemoAdmin` DOがHTTP・WebSocket・内部RPCで使ったオブジェクトを永続記録します。
機能導入前のオブジェクトは、一度アクセスして記録する必要があります。
KV・D1・R2などの外部bindingの内容は対象外です。

1. Room IDと自分の表示名を入力して接続します。
2. AI ID、表示名、性格を指定して**Load or create AI**を押します。
   作成済みのAIはリストから選ぶだけで、保存済みの名前と性格を読み込めます。
   別の画面で作成したAIは「一覧を更新」で取得できます。
3. **Invite AI to this room**で招待し、発言します。
4. 同じRoomを別タブで開くと、他の人間として参加できます。
5. 別Roomで同じAI IDを読み込んで招待すると、そのAIが両方へ参加します。

AI IDの最初の設定を保存します。既存IDの表示名・性格は上書きせず復元します。
別の性格は新しいAI IDで試してください。1 Roomに最大4体のAIを招待でき、
人間の発言ごとに招待順で1回ずつ応答します。
参加AIの**Remove**ボタンで、そのRoomから退出させられます。性格、他Roomへの参加、
過去の発言は保持し、再招待もできます。AIの応答中は退出ボタンを無効にします。
人間の接続時とAIの新規追加時には、本人を含むルーム全員に参加メッセージを配信します。
参加済みAIへの重複した招待では再通知しません。通知は表示言語に合わせ、会話履歴や
モデルへの入力には含めません。

実際の推論は、WranglerをCloudflareで認証した後に起動します。

```sh
npm run dev:example2
```

このディレクトリの`wrangler.jsonc`はremoteなAI bindingを設定しています。
Worker・DOがローカルでもWorkers AIを使い、利用量に加算されます。モデルは
`@cf/meta/llama-3.1-8b-instruct-fp8`で、streamと`max_tokens: 512`を指定します。
[公式binding設定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)と
[モデル仕様](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/)も参照してください。
自動テストは実際の推論を呼びません。

## 採用した設計

| Object | 責務 |
| --- | --- |
| `AICatalog['default']` | 作成済みAIのIDと表示名の永続一覧 |
| `AIParticipant[ai_id]` | 永続化する表示名、初期性格、参加Room ID一覧 |
| `AIChatRoom[room_id]` | 永続化する参加AI一覧、会話履歴、WebSocket配信 |

既存PONDRO namespace内で`[class, id]`が異なるObjectを作ります。アプリとSSE parserは
省略可能な`mrbgems/pondro-example2` mgemへまとめ、core APIは変更していません。
Roomが内部RPCでAIのprofileを読み、自分の履歴で推論します。共通AIのqueueを応答中
ずっと占有しないため、別Roomは同時に応答できます。性格を共有し、履歴は混ぜません。
AIの作成時にcatalogへ登録し、`load`でも登録を補完します。一覧機能導入前のAIは、
既知のIDで一度読み込むと一覧に追加されます。catalogとAIの保存は分散transactionではありません。
POST `/api/AICatalog/default`の`{"method":"list"}`でIDと名前の一覧を取得できます。
`AIParticipant`の`load`はprofileを返し、未作成のAIには`null`を返します。

```ruby
profile = AIParticipant[ai_id].profile.await
stream = bindings.AI.stream!(:generate, profile['model'], input)
Pondro::Example2::SSE.each_delta(stream) do |delta|
  # socket.send_now(...).awaitで全クライアントへ配信
end
stream.close
```

推論には直近20件、永続履歴には完了したメッセージを最大50件残します。このAI自身の
過去の応答だけをassistant roleとし、他の参加者の表示名はuser contentに含めます。
SSEはWorkers AIの`response`とOpenAI形式の`choices[0].delta.content`、CRLF、
複数data行、UTF-8分割、`[DONE]`に対応します。完成前の差分も全WebSocketへ届けます。
推論失敗時も人間の発言を保存し、AIの表示を中断扱いにしてstreamを解放し、次の発言を
受け付けます。1人の切断は他のクライアントやAIの応答を止めません。

## 通信と制限

`/ws/AIChatRoom/<room_id>?name=<display_name>`へ接続し、
`{"type":"invite","ai_id":"sage"}`、`{"type":"remove","ai_id":"sage"}`、
または`{"type":"say","text":"Hello!"}`を送ります。
eventは`welcome`、`participants`、`message`、`ai_start`、`ai_delta`、`ai_error`、
`ready`、`notice`、`error`です。`sequence`はRoom内のメッセージを識別します。
POST `/api/AIParticipant/<ai_id>`へ
`{"method":"configure","args":["Sage","Be a curious botanist."]}`または
`{"method":"profile"}`でAIを作成・参照できます。`join`、`leave`とRoomの`history`は内部RPCのみです。

認証なしのローカルPoCです。性格4096 bytes、人間の発言2000 bytes、AIの発言16 KiB、
SSE入力256 KiB、AIの参加Room数100までです。Room内の発言は直列処理します。
Futureとstreamはイベントをまたげません。履歴はイベント完了時にcommitするため、
途中の配信はcommitに先行しbest effortです。AIの参加RoomとRoomの参加AIは
分散transactionで更新しません。

## 確認

```sh
npm test
npm run test:ruby
npm run test:e2e
npm run test:example2:e2e
```

実Wasmで共通AIを使う複数Roomの同時応答、初期性格の維持、履歴分離、逐次配信、
エラー回復と保存状態の復元を確認します。workerdテストはmock AIで実WebSocket、
招待、UTF-8、切断、再起動後の復元を確認します。
