# Codex Usage Notifier for macOS

Mac miniで24時間常駐し、CodexとClaudeの5時間・週間の利用率、閾値到達、リセットをDiscord Botで通知するTypeScriptアプリです。ターミナルを閉じてもLaunchAgentで動作し、状態とログをローカルに保存します。

## できること

- 使用率80%・90%・95%（設定変更可）を通知
- 5時間リセットと週間リセットを通知
- リセット時に残量100%として通知
- 永続状態による再起動・再ログイン後の重複通知防止
- Codex公式app-serverを1プロセスだけ再利用し、CPU・ディスク負荷を抑制
- Discord送信のタイムアウト、429/5xx再試行、メンション無効化
- LaunchAgentによるログイン時起動と異常終了時再起動
- Tailscale内のWebUIでClaude/Codex残量とリセット予定を確認
- WebUIからDiscord・閾値・リセット・エラー通知を個別にON/OFF
- WebUIから手動更新とDiscord Botの通常/100%復帰テストを実行
- 日次ログローテーションと保存期限による削除
- Claude OAuth利用率の監視と、Geminiを後から接続できるJSONアダプター

> [!IMPORTANT]
> 本ツールはCodex公式app-serverの `account/rateLimits/read` を使用します。直接トークンや `auth.json` は読みません。app-serverが一時的に使えない場合だけ、24時間以内の `~/.codex/sessions` データへフォールバックします。正確な上限判定はCodexの `/usage` 表示を正としてください。

## 変更前 / 変更後

| 項目       | 変更前         | インストール後                                                    |
| ---------- | -------------- | ----------------------------------------------------------------- |
| 常駐監視   | なし           | `com.local.codex-usage-notifier` がログイン中に常駐               |
| 自動再起動 | なし           | 異常終了時にlaunchdが15秒以上空けて再起動                         |
| 再起動後   | 手動実行が必要 | macOSログイン後に自動復帰                                         |
| Discord    | 通知なし       | 閾値・5時間/週間リセットを同一Botチャンネルへ通知                 |
| WebUI      | なし           | `http://<ホストIP>:8791` で残量確認・通知設定・テスト        |
| 重複防止   | なし           | `~/Library/Application Support/CodexNotifier/state.json` に永続化 |
| ログ       | なし           | `~/Library/Logs/CodexNotifier`、14日保存（変更可）                |
| Codex認証  | 既存設定       | 公式CLIが管理。監視アプリは`auth.json`を直接読まない              |

インストーラーがユーザーのCodex設定、Node.js設定、macOS電源設定を書き換えることはありません。

## WebUI

Mac miniと同じTailscaleネットワークの端末から次を開きます。

```text
http://<ホストのTailscale IP>:8791/
```

Claude/Codexの残量、次回リセット、最終取得時刻を表示します。通知ON/OFFと、通知する残量（例: 20・10・5%）はWebUIから数値で変更できます。設定は即時 `config/config.json` へ安全に保存され、サービス再起動後も維持されます。Bot TokenはWebUI/APIへ返しません。

WebUIのバインド先を変更する場合:

```json
"web": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 8791,
  "refreshSeconds": 30
}
```

初期値は `127.0.0.1`（そのMacからのみ閲覧可）です。他の端末から見る場合は、`host` をTailscaleなどVPN内のIPに変更してください。`0.0.0.0` やグローバルIPでインターネットへ直接公開しないでください。

## 動作の仕組み

1. `CodexAppServerProvider` がCodex公式app-serverを常駐させ、`account/rateLimits/read` を1分ごとに読む。
2. `windowDurationMins` を設定済み範囲と照合し、5時間/週間を判別する。`primary`/`secondary` の順序には依存しない。
3. 共通の通知エンジンが、期限切れのリセット予定を先に処理し、その後で閾値、実測リセット、次回予定を評価する。
4. Discord送信前にイベントを永続的にclaimし、プロセスが直後に落ちても同じ通知を再送しない。
5. app-server障害時は、新しいセッション履歴だけを一時的に使用し、古いキャッシュは現在値として扱わない。

Codexを一度も実行していない、またはプランから該当ウィンドウが返されていない場合、そのウィンドウの通知は生成されません。利用率はCodexの応答が返った時点で更新され、リセット通知は最終 `resets_at` からの推定を含みます。

予定時刻より十分早い時点で使用率が下がり、同時に次回リセット時刻が後ろへ更新された場合は、「臨時リセットの可能性」として通知します。Claudeは100%復帰時に `resets_at` がなくなる場合があるため、予定時刻前に使用率がほぼ0%へ戻り、同時に `resets_at` が消えた場合も検出します。APIにはリセットの実施主体を示すフラグがないため、OpenAI/Anthropic運営によるリセットとの断定はせず、使用率と予定情報の変化から検出します。

## 必要環境

- Apple Silicon搭載Mac（M1以降。M4対応）
- macOS 13以降を推奨
- Node.js 22以降（現在の最新版でも可）
- npm
- Mac miniのCodex CLIへChatGPTアカウントでログイン済み
- DiscordアプリへBotを追加し、通知先チャンネルへ投稿できる権限

確認:

```bash
node --version
npm --version
codex --version
```

Node.jsがなければHomebrewで導入します。

```bash
brew install node
```

## プロジェクト構成

```text
codex-usage-notifier/
├── config/
│   └── config.example.json       # 公開用設定テンプレート
├── examples/
│   └── provider-usage.json       # Claude/Geminiアダプター形式
├── launchd/
│   ├── ...notifier.plist.template
│   └── ...logrotate.plist.template
├── scripts/
│   ├── install.sh                # ビルド、検証、LaunchAgent登録
│   ├── uninstall.sh              # LaunchAgentのみ解除
│   ├── update.sh                 # 安全な更新
│   └── rotate-logs.sh            # launchdログのローテーション
├── src/
│   ├── config/                   # Zodによる実行時設定検証
│   ├── core/                     # 監視ループと通知判定
│   ├── logging/                  # JSON Linesログ
│   ├── notifications/            # Discord・テンプレート
│   ├── providers/                # Codex、汎用JSONプロバイダー
│   ├── state/                    # 原子的な重複防止状態
│   └── index.ts                  # CLIエントリーポイント
├── test/
├── .env.example
├── package.json
└── LICENSE
```

## Discord Botの設定

1. Discord Developer Portalでアプリを作り、Botを追加する。
2. Botを通知先サーバーへ招待し、対象チャンネルの「チャンネルを見る」「メッセージを送信」を許可する。
3. Discordの開発者モードをONにし、通知先チャンネルのIDをコピーする。
4. Mac miniで `./scripts/configure-discord-bot.sh` を実行し、Bot TokenとチャンネルIDを入力する。

Bot Tokenは秘密情報です。Git、チャット、スクリーンショット、ログへ載せないでください。漏えいした場合はDeveloper Portalで即時再生成し、設定し直します。

## インストール

常駐させるMacで、プロジェクトへ移動して実行します（別のMacからはSSHで接続して操作できます）。

```bash
cd /path/to/codex-usage-notifier
./scripts/install.sh
```

外付けSSD上へ格納しても問題ありません。LaunchAgentにSSD上の絶対パスが登録されるため、Mac mini起動中はSSDを接続・マウントしたままにしてください。SSDを取り外した状態では監視とWebUIは停止します。

初回は次のファイルが作られ、Bot未設定のためサービス開始前に安全に停止します。

- `.env`（権限600、Git対象外）
- `config/config.json`（Git対象外）
- `~/Library/LaunchAgents/com.local.codex-usage-notifier.plist`
- `~/Library/LaunchAgents/com.local.codex-usage-notifier.logrotate.plist`

対話スクリプトで`.env`を設定します。

```bash
./scripts/configure-discord-bot.sh
```

設定例:

```dotenv
DISCORD_BOT_TOKEN=replace-with-a-new-token
DISCORD_CHANNEL_ID=your-channel-id
```

接続テスト後、インストーラーをもう一度実行します。

```bash
npm run notify:test
./scripts/install.sh
```

インストーラーは `npm ci`（初回lockfile未作成時だけ `npm install`）、format、ESLint、テスト、TypeScriptビルド、plist構文検査を実行してからLaunchAgentを読み込みます。

## 設定

編集対象は `config/config.json` です。変更後はJSONと型を検証し、サービスを再起動します。

```bash
npm run build
launchctl kickstart -k "gui/$(id -u)/com.local.codex-usage-notifier"
```

### 通知ON/OFF

変更前:

```json
{
  "notifications": {
    "enabled": true,
    "thresholdsEnabled": true,
    "resetsEnabled": true,
    "errorsEnabled": true
  }
}
```

変更後の例（リセットだけ通知）:

```json
{
  "notifications": {
    "enabled": true,
    "thresholdsEnabled": false,
    "resetsEnabled": true,
    "errorsEnabled": false
  }
}
```

全通知を止める場合は `notifications.enabled` を `false`、Discord送信だけ止める場合は `discord.enabled` を `false` にします。監視と状態更新は継続するため、再度ONにした時に古い通知が大量送信されません。

### 閾値を変更

変更前:

```json
"thresholds": [80, 90, 95]
```

変更後の例:

```json
"thresholds": [70, 85, 95, 100]
```

1回のCodex応答で複数閾値を飛び越えた場合は、現在状態を表す最も高い閾値を1件だけ通知し、下位閾値も通知済みにします。利用率が閾値から `thresholdRearmMargin` 以上下がるかリセットされると、次周期に再通知できます。

### 通知文を変更

`notifications.templates` の文字列を自由に編集できます。使用可能な変数:

| 変数                 | 内容                    |
| -------------------- | ----------------------- |
| `{provider}`         | Codex / Claude / Gemini |
| `{window}`           | `5時間` / `週間` など   |
| `{windowId}`         | 内部ウィンドウID        |
| `{usedPercent}`      | 使用率                  |
| `{remainingPercent}` | 残量                    |
| `{threshold}`        | 到達閾値                |
| `{resetIn}`          | リセットまでの期間      |
| `{resetAt}`          | リセット日時            |
| `{time}`             | 通知日時                |
| `{error}`            | エラー概要              |

変更前:

```json
"threshold": "🔴 {provider} 使用量警告\n\n対象: {window}\n残り: {remainingPercent}%\n使用済み: {usedPercent}%\n\nリセットまで:\n{resetIn}\n\n時刻: {time}"
```

変更後の例:

```json
"threshold": "⚠️ {provider} {window}: 残り{remainingPercent}%（{resetIn}後に復帰予定）"
```

Discordの通常メッセージ上限に合わせ、各テンプレートは2000文字以内です。`@everyone` などはテンプレートに入れてもメンションとして発火しません。

### ポーリング・ログ

```json
{
  "app": {
    "pollIntervalSeconds": 60,
    "timeZone": "Asia/Tokyo",
    "notifyOnStartup": true,
    "logRetentionDays": 14,
    "logMaxMegabytes": 10
  }
}
```

`pollIntervalSeconds` の最小値は15秒です。通常は60秒で十分です。`notifyOnStartup: false` にすると、初回起動時に既に超えている閾値は通知せず、次周期から監視します。

### Claude 401エラーの通知遅延

Claude OAuthの一時的な更新エラーでDiscordへ通知しないよう、HTTP 401が連続した時間で判定します。

```json
"claude": {
  "authenticationErrorDelayMinutes": 5
}
```

既定値は5分です。5分未満で正常取得へ戻ればDiscord通知は送らず、遅延タイマーをリセットします。5分以上連続した場合は1件だけ通知し、同じ障害が継続している間は再通知しません。ローカルログには遅延中も記録されます。`0`にすると401を即時通知します。

### 5時間/週間の判別範囲

プランや将来の形式変更に備え、固定値ではなく範囲で設定しています。

```json
"windowMappings": [
  { "id": "fiveHour", "label": "5時間", "minMinutes": 240, "maxMinutes": 360 },
  { "id": "weekly", "label": "週間", "minMinutes": 9000, "maxMinutes": 11000 }
]
```

ログに `Ignoring an unmapped Codex rate-limit window` が出た場合だけ、実測された `windowMinutes` に合わせて範囲を追加・修正してください。

## 動作確認

Discordへ送らず現在値を表示:

```bash
npm run status
```

1回だけ通常監視:

```bash
npm run once
```

Discord Botテスト:

```bash
npm run notify:test
```

LaunchAgent状態:

```bash
launchctl print "gui/$(id -u)/com.local.codex-usage-notifier"
```

ログ:

```bash
tail -f "$HOME/Library/Logs/CodexNotifier/notifier-$(date +%F).log"
tail -f "$HOME/Library/Logs/CodexNotifier/launchd.stderr.log"
```

## ログローテーション

アプリログは日付別に作られ、1ファイルが `logMaxMegabytes` を超えた場合も自動分割されます。14日より古いアプリログはアプリ自身が削除します。

launchdの標準出力/標準エラーは、別のLaunchAgentが毎日03:15に確認します。5MB以上ならcopy-truncate方式でgzip圧縮し、14日を超えたローテーション済みファイルを削除します。手動実行:

```bash
./scripts/rotate-logs.sh "$HOME/Library/Logs/CodexNotifier" 5 14
```

## 自動再起動とmacOS再起動後の復帰

本体plistには次が設定されています。

- `RunAtLoad = true`: ユーザーのGUIログイン時に開始
- `KeepAlive.SuccessfulExit = false`: 異常終了時に再起動
- `ThrottleInterval = 15`: クラッシュループを抑制
- `ProcessType = Background`, `Nice = 5`, `LowPriorityIO = true`: バックグラウンド向けの低優先度実行

LaunchAgentはmacOSログイン前には起動しません。再起動後に完全無人で使うには、そのユーザーがログイン状態へ戻る必要があります。自動ログインはセキュリティとのトレードオフがあるため、本ツールは設定を変更しません。Mac miniがスリープすると監視も止まるので、必要に応じて「システム設定」→「省エネルギー」でディスプレイ消灯中の自動スリープを防止してください。

## アップデート

`config/config.json` と `.env` はGit対象外なので保持されます。

```bash
cd /path/to/codex-usage-notifier
./scripts/update.sh
```

変更前: 現在のコード/依存関係で稼働。

変更後: `git pull --ff-only` → lockfileどおりの依存関係 → 全品質チェック → plist再生成 → サービス再起動。

ローカル変更がGitと競合する場合、`git pull --ff-only` は安全に停止します。`state.json` は保持されるため、アップデート後も同一周期の通知は重複しません。

## Claude / Gemini連携

ClaudeはmacOSキーチェーンのClaude Code認証を使って利用率を取得します。401の場合はMac miniでClaude Codeへ再ログインしてください。GeminiはAPI変更の影響を分離するため、外部コレクターとの境界をJSONファイルにしています。

Geminiを有効にする場合:

1. `examples/provider-usage.json` と同じ形式でファイルを原子的に更新するコレクターを用意する。
2. `config/config.json` の `gemini.enabled` を有効化する。

変更前:

```json
"gemini": {
  "enabled": false,
  "displayName": "Gemini",
  "sourceFile": "~/Library/Application Support/CodexNotifier/providers/gemini.json"
}
```

変更後:

```json
"gemini": {
  "enabled": true,
  "displayName": "Gemini",
  "sourceFile": "~/Library/Application Support/CodexNotifier/providers/gemini.json"
}
```

ファイル形式:

```json
{
  "observedAt": "2026-08-02T04:15:00.000Z",
  "windows": [
    {
      "id": "fiveHour",
      "label": "5時間",
      "usedPercent": 90,
      "resetsAt": "2026-08-02T06:29:00.000Z"
    }
  ]
}
```

接続後はCodexと同じ閾値判定、テンプレート、重複防止、Discordチャンネルが使われます。将来公式APIが提供された場合は `UsageProvider` を1クラス追加するだけでJSONコレクターを置き換えられます。

## トラブルシューティング

### `No usage snapshots found yet`

Mac miniで `codex` を起動し、ChatGPTへログイン済みか確認してから `npm run status` を再実行します。続く場合は `providers.codex.appServerCommand` とログを確認します。

### Discord Botが401/403/404

401はBot Token、403はチャンネル権限、404はチャンネルIDを確認します。`./scripts/configure-discord-bot.sh` で`.env`を更新し、サービスを再起動します。

### 通知されない

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.local.codex-usage-notifier.plist"
launchctl print "gui/$(id -u)/com.local.codex-usage-notifier"
npm run status
npm run notify:test
```

`notifications.enabled`、個別ON/OFF、閾値、ログの順に確認します。

### LaunchAgentを手動で再読込

通常はインストーラーを再実行するのが安全です。

```bash
./scripts/install.sh
```

## アンインストール

```bash
./scripts/uninstall.sh
```

2つのLaunchAgentだけを解除してゴミ箱へ移します。再インストール時の重複防止を維持するため、ログ、状態、`.env`、設定は削除しません。完全削除する場合は内容を確認した上で、次を手動でゴミ箱へ移してください。

- `~/Library/Logs/CodexNotifier`
- `~/Library/Application Support/CodexNotifier`
- プロジェクトディレクトリ

## セキュリティとプライバシー

- `~/.codex/auth.json` は読み取らない
- セッション本文をDiscordへ送らない
- ログへBot TokenやJSONL本文を出さない
- `.env`、設定状態ディレクトリ、ログディレクトリをユーザー限定権限で作成
- Discordのallowed mentionsを無効化
- 外部コマンド実行型プロバイダーを標準搭載しない

詳細は `SECURITY.md` を参照してください。

## 開発

```bash
npm ci
cp config/config.example.json config/config.json
npm run check
```

- TypeScript strict mode
- ESLint type-aware rules
- Prettier
- Vitest
- Node.js組み込み `fetch` とmacOS標準launchdを使用

## License

[MIT](LICENSE)
