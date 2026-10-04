# Example 2: AIと人間の共有チャット

[English](README.md)

AI IDごとに性格を保存し、同じAIを複数Roomへ招待できるWebSocketチャットです。
人間も同じRoomに参加します。会話履歴はRoomごとに独立し、JSのUIは`/example2/`です。

## Basic認証

静的アセット・HTTP API・WebSocketの接続開始は、すべてBasic認証を通ります。
`BASIC_AUTH_USER`と`BASIC_AUTH_PASSWORD`をSecretとして設定してください。
未設定・空文字の場合は503、不正な認証情報の場合は401を返します。
ユーザー名に`:`は使えません。パスワードには使用できます。

ローカルでは、利用するWrangler設定と同じディレクトリの`.dev.vars`に記述します。
ルートの設定は`.dev.vars`、Example 2の設定は`example2/.dev.vars`を使います。
これらのファイルはGit管理対象外です。

```dotenv
BASIC_AUTH_USER="demo"
BASIC_AUTH_PASSWORD="replace-with-your-password"
```

公開先のSecretは、Cloudflareの設定画面または以下のコマンドで登録します。
Example 2の場合は`--config example2/wrangler.jsonc`を指定します。
`wrangler secret put`は公開先のWorkerを更新するため、公開時に実行してください。

```sh
npx wrangler secret put BASIC_AUTH_USER --config example2/wrangler.jsonc
npx wrangler secret put BASIC_AUTH_PASSWORD --config example2/wrangler.jsonc
```

ブラウザーで最初に認証すると、同じサイトのアセット・API・WebSocketにも認証情報を
送信します。`admin=1`はログイン後のデモ管理UIを有効にする切り替えのままです。
Wranglerの`assets.run_worker_first: true`で全アセットをWorker経由にしています。
[Secretの公式ドキュメント](https://developers.cloudflare.com/workers/configuration/secrets/)
と[アセットのルーティング](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)を参照してください。

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
ルームIDとあなたの名前も入力時にlocalStorageへ保存し、同じブラウザーで開き直すと
復元します。自動接続は行いません。デモデータの全削除後もこれらの入力値は保持します。
デモ参加者には`/example2/`を共有してください。`admin=1`がないとAIの設定欄と
作成・追加ボタンが無効になり、ルームへの接続と会話は通常どおり利用できます。
この切り替えは画面だけの制限です。サーバー側の認証ではなく、APIとAIの退出操作は
変更していません。

管理者画面の「データをすべてクリア」は、確認後に、このWorkerの全Pondroオブジェクト
（AI、一覧、全Room、会話履歴、Counterなど）の保存データを削除して接続を閉じます。
人間だけのRoomも対象です。進行中のイベントの完了を待ってから削除し、その後は
同じIDで作り直せます。表示言語とCloudflareの認証情報は保持します。
POST `/api/demo/reset?admin=1`がデモ用の初期化APIです。クエリは認証ではありません。
`ObjectRegistry < Pondro::Object`が、このexample2で起動した管理対象のオブジェクトを
`state :objects`で永続記録します。KV・D1・R2などの外部bindingの内容は対象外です。

一覧管理と登録処理は`mrbgems/pondro-example2/mrblib/00_objects.rb`にあります。
`AICatalog`・`AIParticipant`・`AIChatRoom`は共通基底クラス`Example2::Object`を継承し、
`do_initialize`と`do_resume`から`ObjectRegistry['default'].register(identity).await`を呼びます。
対象クラスでhookを上書きするときは`super`を呼んで登録処理を維持してください。
元のplaygroundのCounter・ChatRoom・binding検証用オブジェクトにも同じ登録moduleを
適用し、example2のcontextで有効にします。ルートのplaygroundでは登録を行いません。
管理オブジェクト自身は直接`Pondro::Object`を継承するため、自己登録しません。
未起動のオブジェクトは一覧に含まれません。

`ObjectRegistry`の`register`・`list`・`clear`は内部RPCです。管理役も通常の`PONDRO`
bindingで動き、専用bindingやJSでの自動登録処理はありません。Rubyの`clear`が各対象の
削除をFutureで待ち、すべて成功したら一覧を空にします。途中で失敗した場合は一覧が
保持され、再実行できます。JSには接続の切断・ストレージ削除と、削除中の登録を即座に
拒否するガードが残ります。全削除はオブジェクトのイベント外から開始し、内部RPC経由の
`clear`は呼び出し元自身のイベント完了を待つことを防ぐため拒否します。
古い管理一覧・専用namespaceからの自動移行は行いません。

1. Room IDと自分の表示名を入力して接続します。
2. AI ID、表示名、性格、Workers AIモデルを指定して**Load or create AI**を押します。
   作成済みのAIはリストから選ぶだけで、保存済みの名前・性格・モデルを読み込めます。
   別の画面で作成したAIは「一覧を更新」で取得できます。
3. **Invite AI to this room**で招待し、発言します。
4. 同じRoomを別タブで開くと、他の人間として参加できます。
5. 別Roomで同じAI IDを読み込んで招待すると、そのAIが両方へ参加します。

AI IDの最初の設定を保存します。既存IDの表示名・性格・モデルは上書きせず復元します。
モデルの変更には新しいAI IDを使ってください。選べるモデルはLlama 3.1 8B、GLM-4.7 Flash、
Qwen3 30B A3B、Llama 3.2 3B、OpenAI gpt-oss-20b、Gemma 4 26B A4Bです。
別の性格は新しいAI IDで試してください。
1 Roomに最大4体のAIを招待でき、
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
Worker・DOがローカルでもWorkers AIを使い、利用量に加算されます。作成時に選んだモデルへ
streamと`max_tokens: 512`を指定します。RPCの`configure`でモデルを省略した場合は
`@cf/meta/llama-3.1-8b-instruct-fp8`を使います。
Gemma 4 26B A4B・GLM-4.7 Flashには、推論を無効化するため
`chat_template_kwargs: { enable_thinking: false }`も指定します。
[公式binding設定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)と
[Llama 3.1 8B](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/)、
[GLM-4.7 Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/)、
[Qwen3 30B A3B](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)、
[Llama 3.2 3B](https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/)、
[OpenAI gpt-oss-20b](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)、
[Gemma 4 26B A4B](https://developers.cloudflare.com/ai/models/%40cf/google/gemma-4-26b-a4b-it/)の仕様も参照してください。
自動テストは実際の推論を呼びません。

Workerのvarsで`PONDRO_DIAGNOSTIC`に空でない値（例: `"PONDRO_DIAGNOSTIC": "1"`）を
設定するとagentの推論ステップ・toolの実行ログを表示します。これらは既定では
表示しません。AIエラーの診断ログは設定に関係なく常に表示します。

AIの失敗はWranglerのターミナルに`PONDRO diagnostic` / `example2.ai_error`として
記録します。デプロイ先では`npx wrangler tail --config example2/wrangler.jsonc`で確認できます。
ルーム・AIのID、モデル、プロバイダのエラー、ストリームのフレーム数・最後のフィールド名、
終了理由、使用トークン数、推論部分のバイト数を含みます。プロンプト・会話本文・推論本文は
ログに含めません。空の応答で`finish_reason: length`かつ`reasoning_bytes`が正数なら、
回答を出す前に推論でトークン上限へ達した可能性があります。
この診断機能ではモデルのパラメータ変更や推論の自動リトライは行いません。

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

## tool call対応のagent型Bot

新しいAI IDを作成する前に、Botの種類から「エージェント」を選びます。既存IDの種類は
変更せず、種類未指定のBotは通常のチャットBotとして扱います。agent型BotはRoom内で
`Pondro::Agent#run!`とJSON応答のWorkers AIヘルパーを使い、直列に実行します。
通常Botのストリーミング返信は維持します。tool callに対応するモデルを選んでください。

Rubyで実装した`remember(key, value)`と`recall(key)`を利用できます。
メモリは`state :memory, default: {}`で、RoomとAI IDごとに独立します。再起動や
退出・再招待後も保持し、別Room・別AIとは共有しません。AIごとに32キーまで、キーは
1〜64 bytes、値は256 bytesまでです。toolを使うとチャットに通知が出ます。

mock版では`remember color=blue`、続いて`recall color`と発言すると、実際にRubyの
toolを呼んで結果を受け取ります。推論通信はありません。モデル呼び出しは最大8回です。
失敗は`ai_error`で通知し、次の発言を受け付けます。Roomが例外を捕捉するため、失敗までに
実行したtoolのstate変更は保存される場合があります。外部操作は巻き戻せません。

SSEや独自stream形式のヘルパーについては[agent API](../mrbgems/pondro-agent/README.md)を
参照してください。実モデルのtool callはmockの自動テストでは未検証です。


agent型botは`japan_weather(location, prefecture?, days?)`も利用できます。
「福岡市の明日までの天気を教えて」などと質問してください。
`bindings.fetch`で[地名検索API](https://open-meteo.com/en/docs/geocoding-api)を
日本に限定して検索し、[Weather Forecast API](https://open-meteo.com/en/docs)の
既定のモデル自動選択を使って
日別のWMO天気コード、最高・最低気温（°C）、降水量（mm）を取得します。
日本時間の今日から1〜7日分、既定は3日分です。既存のagent型botにも自動で
追加されます。通常のChat botではtoolは利用しません。

検索には`location: "Fukuoka", prefecture: "福岡県"`のようにローマ字の都市名と
日本語の都道府県名を推奨します。同名の候補が複数ある場合は確認を促し、
見つからない場合は地名の再指定を促します。回答には検索で解決した地域と
Open-Meteo（地名データ: GeoNames）の出典を含めます。APIの通信失敗は
AIエラーとして表示します。offline mock AIが選択するtoolはremember/recallのみです。
天気の利用にはtool対応のliveモデルとOpen-Meteoへの通信が必要です。
