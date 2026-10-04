# PicoRuby PONDRO PoC

[English](README.md)

PONDRO（**Plain Old Durable Ruby Object**）は、RubyオブジェクトをCloudflareの
Durable Objectに対応付ける仕組みです。このリポジトリでは、実際のPicoRubyの
バイトコードをWasmで実行し、永続stateを持つ通常の`Counter`と、WebSocketの
イベントを扱う`ChatRoom`を動かします。
picoruby-cloudflare-worker-wasmや、ほかのWorkerフレームワークには依存しません。

## ローカルで動かす

必要なものは、`rake`を利用できるRuby、WebAssembly JSPIに対応したNode.js
（`WebAssembly.Suspending`と`WebAssembly.promising`が利用可能なもの）、
そして`PATH`上のEmscripten（`emcc`、`emar`）です。
Node.js 26.8.1、Emscripten 6.0.9、およびlockfileで固定したWranglerが導入する
workerdで動作を確認しています。

```sh
npm ci
npm run setup
npm run build
npm run dev
```

[http://localhost:8787](http://localhost:8787)を開き、Counterのボタンを操作したり、
roomに接続したりできます。同じRoom IDでもう一つタブを接続すると、broadcastを
確認できます。Room IDが異なればstateと接続も分かれます。再接続すると、直近50件の
メッセージ履歴を受信します。

チャットではRoom IDとCounter IDを別々に指定します。最初の接続時にroomとCounter IDの
対応を保存し、同じroomのほかのクライアントも同じCounter IDを指定します。
有効な発言ごとに、別のCounter PONDROを一度incrementします。総発言数はチャット右下の
「Total messages」に表示し、再接続時にも取得します。接続・退出通知では増やしません。
複数roomで同じCounter IDを共有すれば、発言数を合算できます。接続中は3秒ごとにも値を
読み直し、ほかのroomで増えた分を表示に反映します。

`setup`は、Git管理対象外の`vendor/`ディレクトリにPicoRubyのリビジョン
`65b7ae6256faa2e53aa0cf8249c8ad5f1cd86327`をチェックアウトし、このビルドに必要な
コンパイラとVMのsubmoduleだけを初期化します。
`build`は`dist/pondro.wasm`を生成します。RubyやCを編集した場合は再ビルドしてください。
WranglerはJS、フロントエンド、Wasmの変更を監視します。ローカルの永続データは
`.wrangler/`配下に保存されます。

npmやEmscriptenのグローバルキャッシュに書き込めない場合は、書き込み可能な
ディレクトリを指定してください。例えば、`npm ci --cache /tmp/pondro-npm-cache`や
`EM_CACHE=/tmp/pondro-em-cache npm run build`を利用できます。

## Rubyオブジェクト

```ruby
class Counter < Pondro::Object
  state :count, default: 0
  rpc :increment, :value, http: true

  def increment
    self.count += 1
  end

  def value
    count
  end
end

class ChatRoom < Pondro::Object
  use Pondro::WebSocket
  state :messages, default: []

  def on_message(socket, message)
    messages << message
    sockets.each { |client| client.send(message) }
  end
end

Pondro.register('Counter', Counter)
Pondro.register('ChatRoom', ChatRoom)
```

実際のサンプルでは、永続的なメッセージ連番、件数を制限した履歴、接続時のwelcome、
別DOのCounterへのincrementとawait、フロントエンド向けのJSONメッセージを追加しています。
[`mrbgems/pondro-example/mrblib/app.rb`](mrbgems/pondro-example/mrblib/app.rb)を参照してください。

`state`はgetterとsetterを定義します。値はJSONにシリアライズできる必要があります。
`messages << entry`のような配列やHashの変更も、次のstateのsnapshotに含まれます。
デフォルト値はイベントごとにdeep copyされ、state、RPC、adapterの宣言はサブクラスにも
継承されます。`rpc :history`はRubyの参照とWorkerのJSから呼び出し可能にし、
HTTP経由の公開はデフォルトで無効です。`rpc :increment, http: true`とするとHTTPからも
呼び出せます。`rpc :increment, :value, http: true`のように複数メソッドへ同じ指定を
適用できます。サブクラスで`http: false`を指定し直すと、継承したHTTP公開を無効にできます。
HTTPリクエストのJSONからこの設定は上書きできず、非公開のメソッドは403を返します。
`send`や`initialize`などの内部メソッドは公開されません。

`use Pondro::WebSocket`により、`on_connect(socket)`、`on_message(socket, text)`、
`on_close(socket, code, reason)`、`on_error(socket)`を扱えるようになります。
`sockets`は現在の接続のproxyを返します。`Pondro::Socket`には`id`、`send(text)`、
`close(code = 1000, reason = '')`があります。保持するのは接続IDとイベント内の
effectsのバッファであり、JSのWebSocketオブジェクトではありません。
Socketを`state`に保存しないでください。

## 採用した設計

参照した「Rubyエージェント構成設計」の議論の後半では、identity、state、dispatchを
coreに置き、イベントadapterを必要に応じて追加する設計が提案されました。
このPoCでは、WasmのRuby側とJS側の両方で、その境界を採用しています。

| コンポーネント | 責務 |
| --- | --- |
| `mrbgems/pondro-core` | `Pondro::Object`、identity、state DSL、RPCの公開メソッド一覧、クラス登録、汎用イベントdispatch |
| `mrbgems/pondro-websocket` | 明示的に有効化するRubyのコールバックと、接続IDによるproxy |
| `mrbgems/pondro-async` | RPCとbinding操作で共通の、イベント内のeager Future |
| `mrbgems/pondro-rpc` | リモートオブジェクトへの参照 |
| `mrbgems/pondro-bindings` | Futureを返すKV・D1・R2・AIのproxyと読み出し専用Stream |
| `mrbgems/pondro-wasm` | C ABI、JSPIによる共通asyncのimport、PicoRuby用のイベント駆動task HAL |
| `mrbgems/pondro-example` | 通常のCounterと、WebSocket付きChatRoom |
| `worker/runtime.js` | Wasmのインスタンス生成、UTF-8 JSONとメモリの受け渡し |
| `worker/host.js` | stateの復元と保存、adapterのeffectsの適用 |
| `worker/adapters/websocket.js` | CloudflareのWebSocket upgrade、hibernation用attachment、Socketへの送信 |
| `worker/adapters/bindings.js` | PondroのFutureと既存のCloudflare host dispatcherを接続 |
| `worker/upstream/` | 無改変・コミット固定のWorker host codecとdispatcher、MITライセンス |
| `worker/index.js` | HTTPルーティングとDurable Objectのライフサイクルhook |
| `public/` | 素のJSで実装したデモ用フロントエンド |

ビルド設定では、ローカルの各ディレクトリをmgemとして読み込みます。
`pondro-core`はWebSocketに依存しません。coreだけを使うアプリケーションでは、
`pondro-websocket`を外し、`pondro-example`を自分のアプリケーションのmgemに
置き換えられます。リモート参照が不要なら`pondro-rpc`も外せます。このデモでは、
core、WebSocket、RPC、binding、および共通のasync基盤をリンクしています。
`pondro-bindings`も省略可能で、RPCとbindingはともに`pondro-async`を利用します。
JS側のupgrade adapterはRuby側にcapabilitiesを問い合わせるため、WebSocket接続を
受け付けるかどうかはRubyの`use`宣言で決まります。

オブジェクトのidentityは「Rubyクラス名とユーザー指定のID」の組です。
この組を曖昧さのない形でエンコードし、`idFromName`に渡します。一つのJSの
Durable Objectクラスで、複数のRubyクラスとidentityを扱います。
activeなDurable Objectごとに、一つのWasmインスタンスとVMを持ちます。
コンパイル済みのWasmモジュール自体は一度だけimportします。
linear memoryの初期サイズは2 MiBで、必要に応じて増え、インスタンスごとの上限は
32 MiBです。これはメモリの設定値であり、activation全体のメモリ使用量を測定した値では
ありません。

C ABIは`pondro_init()`、`pondro_dispatch(json)`、`pondro_destroy()`です。
dispatch用のJSONには、`class`、`id`、`state`、`type`、`payload`、adapter用の
`context`を含めます。Rubyは`value`、更新後の`state`、`effects`を返します。
例えば、`websocket.message`は`ChatRoom#on_message`に対応します。

イベントごとに、宣言されたデフォルト値と永続snapshotからRubyオブジェクトを復元します。
ハンドラは`Future#await`で実行を中断できます。hostのキューは各Durable Object内の
イベントを直列化し、VMへの再入とsnapshotの更新取りこぼしを防ぎます。
イベントがキューの先頭に来た時点でstateを復元し、storage transactionの外でRubyを
実行します。戻ってきたsnapshotは短い同期SQLite transactionで保存し、その後でSocketの
effectsを適用します。リモートのawait中はstorage transactionを保持しません。
Ruby側でイベントが失敗した場合、そのイベントのローカルstateとSocketのeffectsは
反映されません。通常のインスタンス変数はイベント内だけの値です。別のイベントや
activationにも残るのは、宣言された`state`だけです。
VMを維持していても、Rubyのheap上のオブジェクトが永続化されるわけではありません。

## リモートオブジェクトとFuture.await

```ruby
class ChatRoom < Pondro::Object
  use Pondro::WebSocket

  def on_message(socket, message)
    pending = Counter[id].increment
    # リモート呼び出しは開始済み。ここで同期的なRubyの処理を進められる。
    count = pending.await
    socket.send("Message count: #{count}")
  rescue Pondro::RemoteError => error
    socket.send("Counter failed: #{error.message}")
  end
end
```

`Counter[id]`は、指定したIDを持つ別の永続Counterへの参照を返します。
公開メソッドを呼ぶと、リモート呼び出しをすぐに開始し、`Pondro::Future`を返します。
`pending.await`は、呼び出しが完了するまで現在のRuby/Wasmの実行を中断します。
JavaScriptの実行はブロックしません。`pending.read`は`await`の別名です。
同じFutureでawaitやreadを繰り返した場合は、キャッシュされた値を返すか、同じ
`Pondro::RemoteError`を再度raiseします。RPCをもう一度発行することはありません。
Futureはイベント内だけで使うもので、永続taskではありません。`state`に保存しないでください。

Cのbridgeは、同期的な`pondro.async_start`と、実行を中断できる`pondro.async_await`を
importします。JSはDurable Objectのstubに対して`invoke` RPCを開始し、Promiseを
tokenに対応付けて保持します。awaitのimportを`WebAssembly.Suspending`で包み、
dispatchのexportを`WebAssembly.promising`で包むことで、Promiseが完了するまで
Ruby、C、Wasmのstackを維持します。これらのwrapperは独自のstandalone JS runtimeで
提供するため、Emscriptenが生成するJS runtimeやJSPIの変換処理は必要ありません。
[WebAssemblyのJSPI proposal](https://github.com/WebAssembly/js-promise-integration)と
[Emscriptenの非同期処理のドキュメント](https://emscripten.org/docs/porting/asyncify.html)も
参照してください。

awaitしなかったFutureについても、イベントが完了する前に処理の終了を待ちます。
リモート側の失敗はJSの未処理のPromise rejectionにならないように処理しますが、
Rubyからその失敗を受け取れるのはawaitやreadを呼んだ場合です。
待機中のイベントはVMをactiveなまま保持します。hibernationや再起動をまたいで復元できる
checkpointではありません。

このデモでは、有効なメッセージごとに`Counter[counter_id].increment.await`を実行します。
戻り値の`count`はbroadcastと履歴に含まれ、チャット右下の「Total messages」に表示します。
同じCounterの値は、`/api/Counter/<counter_id>`からも確認できます。

transactionは各オブジェクト内で完結します。Counterのincrementが成功した後に
ChatRoomが失敗しても、Counterの更新は巻き戻りません。自動retryやexactly-onceの
保証はありません。伝搬する呼び出しchain内の自己呼び出しと循環呼び出しを拒否し、
chainの長さは最大16オブジェクトに制限しています。リモート呼び出しは10秒でtimeoutします。
これにより、別々に開始した呼び出しがbusyなオブジェクト間で互いを待つ場合も、
待機時間を制限します。timeoutはリモート操作をキャンセルしません。操作が後から完了し、
リモートのstateを変更する可能性があります。
デモのJS resolverはCounter、ChatRoom、BindingProbe、StreamProbe、GenericProbeに対応しています。Rubyクラスを追加する場合は、
JS側のルーティングとresolverにも追加する必要があります。

JS adapterはCloudflareのhibernation API（`acceptWebSocket`、`getWebSockets`、
`serializeAttachment`、`deserializeAttachment`）を使います。
接続IDとオブジェクトのidentityはattachmentに保存するため、activation後のコールバックで、
メモリ上のSocket一覧に頼らずRubyのproxyを復元できます。
公式の[WebSocket hibernationのドキュメント](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)と
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)を
参照してください。

## その他のCloudflare binding

[picoruby-cloudflare-worker-wasm](https://github.com/udzura/picoruby-cloudflare-worker-wasm)の
host-call codecとdispatcherを再利用しています。`worker/upstream/source.json`に
コミット`63e2611d9c56d046ebcfd5b83837cdecaed060ba`とSHA-256を固定し、JSソースを
無改変で、MITライセンスとともに取り込んでいます。`npm run sync:bridge`で固定した
ソースを取得・検証できます。Emscriptenが生成するJS、Rackのライフサイクル、
upstreamのCランタイムは組み込んでいません。

```ruby
class MyObject < Pondro::Object
  use Pondro::Bindings

  def load_profile(user_id)
    cached = bindings[:CACHE].get(user_id)
    stored = bindings[:DB].prepare('SELECT body FROM pondro_notes WHERE id = ?')
                         .bind(user_id).first('body')
    { 'kv' => cached.await, 'd1' => stored.await }
  rescue Pondro::BindingError => error
    { 'error' => error.message }
  end
end
```

KVの`get`と`put(key, text, ttl: nil)`はeager Futureを返します。存在しない値は`nil`、
空文字は`''`、書き込み結果は`nil`です。今回のadapterはUTF-8文字列に対応し、
不正なUTF-8は置き換えずエラーにします。D1は明示的な`prepare`と、元のstatementを
変更しない`bind`を使い、`run`、`first`（column指定可能）、`raw(column_names: false)`が
Futureを返します。引数、TTL、scalar parameter、binding型、エラーの検証は共通dispatcherが
担当し、bindingの失敗はawait時にキャッシュした`Pondro::BindingError`をraiseします。

`worker/index.js`から明示的な型一覧（`CACHE: 'kv', DB: 'd1', BUCKET: 'r2', AI: 'ai'`）をadapterへ渡し、
Rubyにはproxy用のmetadataとして渡します。接続層はKVのget/put、D1の実行、R2のget、AIのrunとstreamの読み出し操作を許可します。
型付きR2 proxyは読み出しに対応します。
`wrangler.jsonc`のKV・D1のIDはローカルデモ用の仮の値なので、デプロイする場合は
実際のresource IDに変更してください。setupやテストはCloudflare上のresourceを作成しません。

`BindingProbe`サンプルはD1のtableを作成し、D1とKVの両方へnoteを保存します。

```sh
curl -X POST http://localhost:8787/api/BindingProbe/note \
  -H 'Content-Type: application/json' \
  -d '{"method":"store_note","args":["hello bindings"]}'
# {"value":{"kv":"hello bindings","d1":"hello bindings"}}
```

その後`read_note`で両方を読み出せます。table作成のため、最初に`store_note`を呼んでください。
外部bindingへの操作はDOのsnapshotと一緒に巻き戻らず、KVとD1の書き込みもatomicでは
ありません。ローカルKVでは書き込み直後の読み出しが通りますが、本番のKVでは
整合性の特性により以前の値が返る場合があります。
upstreamとの共通mgem抽出は今後の対象です。現段階では再現可能なJSのsnapshotとして
依存を取り込み、読み出しstreamは現在のイベントが所有します。

## 汎用bindingの呼び出し

Ruby側に専用proxyがないbindingは、`BindingAdapter`へ渡す一覧に
`{ SERVICE: 'generic' }`のように登録できます。Wranglerにも実際のbindingを
設定してください。既存の型付きbindingと同じ一覧に登録できます。

```ruby
pending = bindings.SERVICE.someMethod('hello', limit: 10)
result = pending.await
# JSでは env.SERVICE.someMethod('hello', { limit: 10 }) を呼びます。

result = bindings[:SERVICE].invoke(:someMethod, 'hello').await
```

メソッド名と位置引数をそのまま転送し、JSのreceiverも保持します。Rubyのキーワード
引数は末尾のoptions objectになります。引数と戻り値はJSONの値に対応し、ネストした
object・array、文字列、有限の数値（整数はJSの安全な範囲内）、boolean、nullを扱えます。
JSの`undefined`はRubyの`nil`になります。Response、Date、ArrayBuffer、streamなどの
特殊objectはエラーになり、汎用のstreamやresourceのメソッドチェーンには対応しません。
JSの例外、存在しないメソッド、登録済みでも`env`に実在しないbindingは、await時に
`Pondro::BindingError`になります。未登録の名前はRuby側のlookupで失敗します。
Rubyのメソッド名と衝突する場合は`invoke`を使えます。constructor・prototypeの
メソッドは呼び出せません。

`GenericProbe#call_service`は内部RPCからこの経路を確認するサンプルで、HTTPには
公開していません。別途generic bindingの設定が必要です。登録したbindingでは
対応する任意のメソッドを呼べるため、Rubyに公開したいbinding名を登録してください。

## R2・AIのstream読み出し

登録済みのbindingはドットでも参照できます。`bindings.AI`と`bindings[:AI]`は同じproxyを
返します。既存のRubyメソッド名と衝突するbinding名は`[]`で参照してください。

```ruby
object = bindings[:BUCKET].get('sample').await
stream = object.body # bodyがない場合はnil。存在しないobjectのgetもnil

while (line = stream.readline.await)
  socket.send_now(line).await
end

ai_stream = bindings.AI.generate(model, { 'prompt' => 'hello' }, stream: true).await
chunk = ai_stream.read_partial(1024).await
rest = ai_stream.read_all(max_bytes: 65_536).await
ai_stream.close.await
```

R2の結果は`metadata`と読み出し用の`body`を持ちます。AIの`run`はmodelに依存しないAPIで、
`generate(..., stream: true)`はstreamを要求し、デフォルトではJSONを返します。
サンプルの型一覧にはAIがありますが、`wrangler.jsonc`ではAI resourceを設定していません。
実際のmodelを利用する場合は対応するbindingを設定してください。
テストではAI bindingのmockを使い、課金される推論やremoteの推論は呼び出しません。

| 読み出し操作 | 結果 |
| --- | --- |
| `read_partial(n).await` | 最大nバイトの届いた分を返す。nが埋まるまで待たず、EOFではnil |
| `readline(max_bytes: 1_048_576).await` | 改行を含む。CRLF・空行・最後の改行なしの行を保持し、EOFではnil |
| `read_all(max_bytes: 1_048_576).await` | 残り全体。EOFでは空文字。上限を超えたらエラーにしてキャンセル |
| `close.await` | sourceをキャンセルして解放。繰り返し可能 |

読み出し上限はすべて最大1 MiBで、`read_partial`には正の整数が必要です。
同じstreamの読み出しは直列化し、読み残しを共有します。行とchunkはバイナリのRuby文字列です。
既存のJSON/Future ABIではバイト配列として渡し、`mruby-pack`で文字列を復元するため、
UTF-8の途中で分割されてもdecodeや置き換えは行いません。
textとして送る際は完全なUTF-8を組み立ててください。AIのstreamは通常SSEなどの生の出力で、
生成tokenのparserは含みません。

未読streamは、失敗したイベントやawaitしなかったopenも含め、イベント終了時にキャンセルします。
openの完了後、awaitしていないreadを先にキャンセルしてからFutureの終了を待つため、
データ待ちのreadがイベントの後片付けを止めることはありません。
handleは次のイベントへ持ち越せず、stateへ保存できません。
sourceのエラーは`Pondro::BindingError`として伝わります。
無改変のupstream dispatcherがR2・AIを検証してdescriptorを生成し、呼び出し単位のwrapperが
実際のsourceを取得して、Pondroのイベント単位のread registryへ接続します。
workerdのネイティブなR2 metadataは、JSONの検証前に正規化します。

`socket.send_now(text).await`はイベント中の即時送信を明示的に選ぶAPIです。
後続の処理が失敗しても送信は巻き戻りません。従来の`socket.send`はstateのcommit後に送ります。
`StreamProbe`サンプルは`/ws/StreamProbe/<id>`でR2のobject keyを受け取り、
`line`のJSONイベントを順次送り、最後に`done`を送ります。
HTTPの`read_object`は、不正なUTF-8も扱えるバイト配列を返します。
streamの書き込みやR2 putのAPIは追加していません。

## エンドポイント

```sh
curl -X POST http://localhost:8787/api/Counter/demo \
  -H 'Content-Type: application/json' \
  -d '{"method":"increment","args":[]}'
# {"value":1}

curl -X POST http://localhost:8787/api/ChatRoom/lobby \
  -H 'Content-Type: application/json' \
  -d '{"method":"history"}'
# HTTP 403: historyは内部RPCからのみ呼び出せます
```

`/ws/ChatRoom/lobby?counter_id=message-total`にWebSocketで接続し、plain textを送信します。
`counter_id`を省略した場合はRoom IDを使います。
サーバはJSONの`welcome`イベントと`message`イベントを送信します。
CounterはWebSocket adapterを使わないため、`/ws/Counter/demo`へのupgradeは拒否します。

クライアントが切断すると、`ChatRoom#on_close`が、同じroomに残っているクライアントへ
JSONの`left`イベントをbroadcastします。フロントエンドには「left the room」と表示されます。
退出通知は一時的なもので、チャット履歴には保存しません。

## 検証

```sh
npm run test:ruby
npm test
npm run test:e2e
```

* CRubyのテストでは、WebSocket mgemを読み込まずにcoreを検証します。継承、変更可能な
  デフォルト値の独立性、RPCの明示的な公開、例外処理を確認します。Futureのテストでは、
  呼び出しの即時開始、await/readの結果キャッシュ、リモートエラーのキャッシュを確認します。
* Nodeのテストでは、ビルドしたPicoRuby Wasmを実際にインスタンス化します。VMの分離、
  snapshotの復元、Unicode、履歴件数の制限、adapterの明示的な有効化、失敗したイベント、
  effects適用前の永続化、新しいVMでのproxyの復元を確認します。実際のJSPIによる実行中断、
  リモート側の失敗からの復帰、並行イベントの直列化、VMへの再入拒否、循環呼び出しの拒否も
  検証します。
* workerdのE2Eテストでは、一時storageとランダムなloopback portでWranglerを起動します。
  Counterへの並行increment、2クライアントへのbroadcast、roomの分離、Unicode、不正な
  RPC・upgrade・body・バイナリ入力、既存bridge経由のKV・D1操作、R2 stream読み出しとWebSocketへの行送信、再起動後の永続化、
  ChatRoomから別のCounter DOへのFuture.await、
  退出通知のbroadcast、サーバ停止・再起動後の両オブジェクトの永続化を確認します。
  終了時にはサーバと一時データを片付けます。

## このPoCの範囲と制限

サンプルに認証はありません。HTTP部分は四つのサンプルクラスを扱うJS adapterであり、
汎用のRack実装や、任意のRubyコードをリモート実行する仕組みではありません。
メッセージはtextのみで、UTF-8で4096 bytesまでです。RPCのbodyは8192 bytesまでです。
チャット履歴は50件まで保持します。

state保存後のSocketへの送信はbest effortです。永続outboxによるatomicな配送や、
exactly-onceの配送は保証しません。保存済みのメッセージを、切断後に履歴から取得し直す
必要がある場合があります。このPoCにはalarm、queue、workflow、非同期のRuby Task
schedulingはありません。外部RPCのawaitにはJSPIを使います。

hibernationに対応するコールバックとattachmentの経路は実装しています。
テストでは、新しいVMでの復元とローカルサーバの再起動を確認しています。
実際のCloudflare上で、接続を維持したままidle hibernationする動作と、本番でのメモリ使用量は、
デプロイした環境での検証が必要であり、まだ測定していません。
setup、build、テストではデプロイを行いません。
