/**
 * Ready-to-run push scripts, generated with the token and payload already
 * filled in.
 *
 * All ten languages are produced at once rather than on demand: the editor shows
 * them as tabs, and someone who works in Perl should not have to discover that
 * Perl is an option.
 *
 * Every template follows the same shape — constants at the top, a `measure`
 * function to fill in, the send, and a non-zero exit on failure — so moving
 * between languages costs nothing. Comments are in English, as befits an
 * open-source project.
 *
 * These functions are pure and live in `shared` rather than in the web app so
 * that the same source produces both the editor's tabs and the committed
 * examples under `clients/examples/`. Two copies of a script that must stay
 * correct is one copy too many.
 */

/**
 * What the script sends, decided by the widget the control is drawn with.
 *
 * `status` times a check and classifies it against thresholds; `value` measures
 * a number and sends it. Generating the wrong one gives someone a script that
 * runs, reports success, and feeds a chart that stays empty.
 */
export type PayloadShape = 'status' | 'value'

export interface TemplateContext {
  /** Base URL of the API, e.g. https://status.example.com */
  baseUrl: string
  /** Control key the script pushes against. */
  controlKey: string
  /** Shown once at creation; the caller decides whether to inline it. */
  apiKey: string
  /** Latency above which the control is considered degraded, in ms. */
  degradedMs?: number
  /** Latency above which it is considered down, in ms. */
  downMs?: number
  /** Defaults to `status`, which is what every control had before widgets. */
  payloadShape?: PayloadShape
  /** Named in the comments of a value script, so the unit is not a mystery. */
  valueUnit?: string
  valueLabel?: string
}

function shapeOf(ctx: TemplateContext): PayloadShape {
  return ctx.payloadShape ?? 'status'
}

/**
 * Which payload each widget is fed.
 *
 * Lives here rather than only in the web app's registry because the API also
 * needs it: the scripts endpoint has the control's widget id and must generate
 * the matching shape. The registry's own test asserts these agree, so the two
 * cannot drift into a state where the editor promises one thing and the
 * generated script does another.
 */
const WIDGET_PAYLOAD_SHAPES: Record<string, PayloadShape> = {
  'uptime-ribbon': 'status',
  'status-swimlane': 'status',
  'availability-calendar': 'status',
  'latency-band': 'status',
  'value-bullet': 'value',
  'live-sparkline': 'value',
  'stat-tile': 'status',
}

export function payloadShapeForWidget(widgetId: string): PayloadShape {
  // An unknown widget falls back to the shape every control had before widgets
  // existed, rather than throwing on a page nobody can then fix.
  return WIDGET_PAYLOAD_SHAPES[widgetId] ?? 'status'
}

/** What the `measure()` stub should say it returns, per shape. */
/**
 * The opening line of every generated script.
 *
 * It names what the script actually pushes. "Push a status measurement" above a
 * script that sends a queue depth is the kind of small lie that makes a reader
 * distrust the rest of the file.
 */
function headline(ctx: TemplateContext): string {
  return shapeOf(ctx) === 'value'
    ? `Push a ${ctx.valueLabel ?? 'value'} measurement to TERN.`
    : '${headline(ctx)}'
}

function measureHint(ctx: TemplateContext): string {
  return shapeOf(ctx) === 'value'
    ? `Replace with the real check. Return the ${ctx.valueLabel ?? 'measurement'}${ctx.valueUnit ? ` in ${ctx.valueUnit}` : ''}.`
    : 'Replace with the real check. Return elapsed milliseconds, or fail.'
}

export interface ScriptTemplate {
  id: string
  label: string
  extension: string
  /** Highlighting hint for the editor. */
  syntax: string
  render(ctx: TemplateContext): string
}

const DEFAULT_DEGRADED = 500
const DEFAULT_DOWN = 3000

function thresholds(ctx: TemplateContext) {
  return {
    degraded: ctx.degradedMs ?? DEFAULT_DEGRADED,
    down: ctx.downMs ?? DEFAULT_DOWN,
  }
}

function endpoint(ctx: TemplateContext): string {
  return `${ctx.baseUrl.replace(/\/$/, '')}/api/v1/ingest`
}

// ── 1. Python ───────────────────────────────────────────────────────────────

const python: ScriptTemplate = {
  id: 'python',
  label: 'Python',
  extension: 'py',
  syntax: 'python',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env python3
"""${headline(ctx)} Standard library only."""

import json
import os
import time
import urllib.error
import urllib.request

ENDPOINT = "${endpoint(ctx)}"
CONTROL_KEY = "${ctx.controlKey}"
# Read from the environment so the key does not live in the script — and so this
# file is safe to commit.
API_KEY = os.environ.get("TERN_API_KEY", "${ctx.apiKey}")

${
  shapeOf(ctx) === 'value'
    ? ''
    : `DEGRADED_MS = ${t.degraded}
DOWN_MS = ${t.down}`
}


def measure():
    """${measureHint(ctx)}"""
${
  shapeOf(ctx) === 'value'
    ? `    with urllib.request.urlopen("https://example.com/metrics", timeout=10) as response:
        return float(json.load(response)["pending"])`
    : `    started = time.monotonic()
    urllib.request.urlopen("https://example.com", timeout=DOWN_MS / 1000).read()
    return (time.monotonic() - started) * 1000`
}


def main():
${
  shapeOf(ctx) === 'value'
    ? `    try:
        payload = {"controlKey": CONTROL_KEY, "value": measure()}
    except Exception as error:  # noqa: BLE001 - a failed measurement is a failed check
        payload = {"controlKey": CONTROL_KEY, "status": "down", "message": str(error)[:200]}`
    : `    try:
        latency = measure()
        status = "operational"
        if latency >= DOWN_MS:
            status = "down"
        elif latency >= DEGRADED_MS:
            status = "degraded"
        message = None
    except Exception as error:  # noqa: BLE001 - any failure is a failed check
        latency, status, message = None, "down", str(error)[:200]

    payload = {"controlKey": CONTROL_KEY, "status": status}
    if latency is not None:
        payload["latencyMs"] = round(latency)
    if message:
        payload["message"] = message`
}

    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + API_KEY},
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            print(response.status, response.read().decode())
    except urllib.error.HTTPError as error:
        # Exit non-zero so cron or a CI step notices the push itself failed.
        print("push failed:", error.code, error.read().decode())
        raise SystemExit(1)


if __name__ == "__main__":
    main()
`
  },
}

// ── 2. PowerShell ───────────────────────────────────────────────────────────

const powershell: ScriptTemplate = {
  id: 'powershell',
  label: 'PowerShell',
  extension: 'ps1',
  syntax: 'powershell',
  render(ctx) {
    const t = thresholds(ctx)
    return `#Requires -Version 5.1
<#
    ${headline(ctx)} Works on Windows PowerShell 5.1 and
    PowerShell 7+ with no modules to install.
#>

$Endpoint   = "${endpoint(ctx)}"
$ControlKey = "${ctx.controlKey}"
# From the environment when set, so this file is safe to commit.
$ApiKey     = if ($env:TERN_API_KEY) { $env:TERN_API_KEY } else { "${ctx.apiKey}" }

${
  shapeOf(ctx) === 'value'
    ? ''
    : `$DegradedMs = ${t.degraded}
$DownMs     = ${t.down}`
}

function Measure-Target {
    # ${measureHint(ctx)}
${
  shapeOf(ctx) === 'value'
    ? `    $response = Invoke-RestMethod -Uri "https://example.com/metrics" -TimeoutSec 10
    return [double]$response.pending`
    : `    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri "https://example.com" -UseBasicParsing -TimeoutSec ($DownMs / 1000) | Out-Null
    $sw.Stop()
    return $sw.Elapsed.TotalMilliseconds`
}
}

$payload = @{ controlKey = $ControlKey }

try {
${
  shapeOf(ctx) === 'value'
    ? `    $payload.value = Measure-Target`
    : `    $latency = Measure-Target
    $payload.latencyMs = [math]::Round($latency)
    $payload.status = if ($latency -ge $DownMs) { "down" }
                      elseif ($latency -ge $DegradedMs) { "degraded" }
                      else { "operational" }`
}
} catch {
    $payload.status  = "down"
    $payload.message = $_.Exception.Message.Substring(0, [Math]::Min(200, $_.Exception.Message.Length))
}

try {
    $response = Invoke-RestMethod -Uri $Endpoint -Method Post \`
        -Headers @{ Authorization = "Bearer $ApiKey" } \`
        -ContentType "application/json" \`
        -Body ($payload | ConvertTo-Json -Compress) \`
        -TimeoutSec 10
    $response | ConvertTo-Json -Compress
} catch {
    Write-Error "push failed: $($_.Exception.Message)"
    exit 1
}
`
  },
}

// ── 3. Bash ─────────────────────────────────────────────────────────────────

const bash: ScriptTemplate = {
  id: 'bash',
  label: 'Bash',
  extension: 'sh',
  syntax: 'bash',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env bash
# ${headline(ctx)} Needs only curl.
set -euo pipefail

ENDPOINT="${endpoint(ctx)}"
CONTROL_KEY="${ctx.controlKey}"
# From the environment when set, so this file is safe to commit.
API_KEY="\${TERN_API_KEY:-${ctx.apiKey}}"

${
  shapeOf(ctx) === 'value'
    ? ''
    : `DEGRADED_MS=${t.degraded}
DOWN_MS=${t.down}`
}

# ${measureHint(ctx)}
${
  shapeOf(ctx) === 'value'
    ? `measure() {
  curl -fsS --max-time 10 "https://example.com/metrics" \\
    | sed -n 's/.*"pending"[[:space:]]*:[[:space:]]*\\([0-9.]*\\).*/\\1/p'
}

if value="$(measure)" && [ -n "$value" ]; then
  payload="$(printf '{"controlKey":"%s","value":%s}' "$CONTROL_KEY" "$value")"
else
  payload="$(printf '{"controlKey":"%s","status":"down","message":"measurement failed"}' "$CONTROL_KEY")"
fi`
    : `measure() {
  curl -fsS -o /dev/null -w '%{time_total}' --max-time "$((DOWN_MS / 1000))" \\
    "https://example.com" | awk '{ printf "%.0f", $1 * 1000 }'
}

if latency="$(measure)"; then
  if   [ "$latency" -ge "$DOWN_MS" ];     then status="down"
  elif [ "$latency" -ge "$DEGRADED_MS" ]; then status="degraded"
  else                                         status="operational"
  fi
  payload="$(printf '{"controlKey":"%s","status":"%s","latencyMs":%s}' \\
    "$CONTROL_KEY" "$status" "$latency")"
else
  payload="$(printf '{"controlKey":"%s","status":"down","message":"check failed"}' "$CONTROL_KEY")"
fi`
}

if ! curl -fsS --max-time 10 -X POST "$ENDPOINT" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "$payload"; then
  # Exit non-zero so cron notices the push itself failed.
  echo "push failed" >&2
  exit 1
fi
echo
`
  },
}

// ── 4. Go ───────────────────────────────────────────────────────────────────

const go: ScriptTemplate = {
  id: 'go',
  label: 'Go',
  extension: 'go',
  syntax: 'go',
  render(ctx) {
    const t = thresholds(ctx)
    return `// ${headline(ctx)} Standard library only.
//
//	go run tern_push.go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

const (
	endpoint   = "${endpoint(ctx)}"
	controlKey = "${ctx.controlKey}"

${
  shapeOf(ctx) === 'value'
    ? ''
    : `	degradedMs = ${t.degraded}
	downMs     = ${t.down}`
}
)

type point struct {
	ControlKey string   \`json:"controlKey"\`
	Status     string   \`json:"status,omitempty"\`
	LatencyMs  *int64   \`json:"latencyMs,omitempty"\`
	Value      *float64 \`json:"value,omitempty"\`
	Message    string   \`json:"message,omitempty"\`
}

// ${measureHint(ctx)}
func measure() (float64, error) {
${
  shapeOf(ctx) === 'value'
    ? `	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://example.com/metrics")
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var body struct {
		Pending float64 \`json:"pending"\`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, err
	}
	return body.Pending, nil`
    : `	started := time.Now()
	client := &http.Client{Timeout: downMs * time.Millisecond}
	resp, err := client.Get("https://example.com")
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return float64(time.Since(started).Milliseconds()), nil`
}
}

func main() {
	apiKey := os.Getenv("TERN_API_KEY")
	if apiKey == "" {
		// From the environment when set, so this file is safe to commit.
		apiKey = "${ctx.apiKey}"
	}

	p := point{ControlKey: controlKey}

	measured, err := measure()
	if err != nil {
		p.Status = "down"
		p.Message = err.Error()
	} else {
${
  shapeOf(ctx) === 'value'
    ? `		p.Value = &measured`
    : `		latency := int64(measured)
		p.LatencyMs = &latency
		switch {
		case latency >= downMs:
			p.Status = "down"
		case latency >= degradedMs:
			p.Status = "degraded"
		default:
			p.Status = "operational"
		}`
}
	}

	body, _ := json.Marshal(p)
	req, _ := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "push failed:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		fmt.Fprintln(os.Stderr, "push rejected:", resp.Status)
		os.Exit(1)
	}
	fmt.Println(resp.Status)
}
`
  },
}

// ── 5. Node.js ──────────────────────────────────────────────────────────────

const node: ScriptTemplate = {
  id: 'node',
  label: 'Node.js',
  extension: 'mjs',
  syntax: 'javascript',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env node
// ${headline(ctx)} Node 18+, no dependencies.

const ENDPOINT = '${endpoint(ctx)}'
const CONTROL_KEY = '${ctx.controlKey}'
// From the environment when set, so this file is safe to commit.
const API_KEY = process.env.TERN_API_KEY ?? '${ctx.apiKey}'

${
  shapeOf(ctx) === 'value'
    ? ''
    : `const DEGRADED_MS = ${t.degraded}
const DOWN_MS = ${t.down}`
}

/** ${measureHint(ctx)} */
${
  shapeOf(ctx) === 'value'
    ? `async function measure() {
  const response = await fetch('https://example.com/metrics', {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return Number((await response.json()).pending)
}

const payload = { controlKey: CONTROL_KEY }

try {
  payload.value = await measure()
} catch (error) {
  payload.status = 'down'
  payload.message = String(error).slice(0, 200)
}`
    : `async function measure() {
  const started = performance.now()
  const response = await fetch('https://example.com', {
    signal: AbortSignal.timeout(DOWN_MS),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return performance.now() - started
}

const payload = { controlKey: CONTROL_KEY }

try {
  const latency = await measure()
  payload.latencyMs = Math.round(latency)
  payload.status =
    latency >= DOWN_MS ? 'down' : latency >= DEGRADED_MS ? 'degraded' : 'operational'
} catch (error) {
  payload.status = 'down'
  payload.message = String(error).slice(0, 200)
}`
}

const response = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10_000),
})

if (!response.ok) {
  // Exit non-zero so cron or a CI step notices the push itself failed.
  console.error('push failed:', response.status, await response.text())
  process.exit(1)
}
console.log(response.status, await response.text())
`
  },
}

// ── 6. Ruby ─────────────────────────────────────────────────────────────────

const ruby: ScriptTemplate = {
  id: 'ruby',
  label: 'Ruby',
  extension: 'rb',
  syntax: 'ruby',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env ruby
# ${headline(ctx)} Standard library only.

require 'json'
require 'net/http'
require 'uri'

ENDPOINT    = '${endpoint(ctx)}'
CONTROL_KEY = '${ctx.controlKey}'
# From the environment when set, so this file is safe to commit.
API_KEY     = ENV.fetch('TERN_API_KEY', '${ctx.apiKey}')

${
  shapeOf(ctx) === 'value'
    ? ''
    : `DEGRADED_MS = ${t.degraded}
DOWN_MS     = ${t.down}`
}

# ${measureHint(ctx)}
def measure
${
  shapeOf(ctx) === 'value'
    ? `  response = Net::HTTP.get_response(URI('https://example.com/metrics'))
  raise response.message unless response.is_a?(Net::HTTPSuccess)

  JSON.parse(response.body).fetch('pending').to_f`
    : `  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  Net::HTTP.get_response(URI('https://example.com'))
  (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000`
}
end

payload = { controlKey: CONTROL_KEY }

begin
${
  shapeOf(ctx) === 'value'
    ? `  payload[:value] = measure`
    : `  latency = measure
  payload[:latencyMs] = latency.round
  payload[:status] =
    if    latency >= DOWN_MS     then 'down'
    elsif latency >= DEGRADED_MS then 'degraded'
    else                              'operational'
    end`
}
rescue StandardError => e
  payload[:status]  = 'down'
  payload[:message] = e.message[0, 200]
end

uri = URI(ENDPOINT)
http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = uri.scheme == 'https'
http.read_timeout = 10

request = Net::HTTP::Post.new(uri.path, {
  'Content-Type'  => 'application/json',
  'Authorization' => "Bearer #{API_KEY}"
})
request.body = payload.to_json

response = http.request(request)
puts "#{response.code} #{response.body}"
# Exit non-zero so cron notices a rejected push.
exit 1 unless response.is_a?(Net::HTTPSuccess)
`
  },
}

// ── 7. PHP ──────────────────────────────────────────────────────────────────

const php: ScriptTemplate = {
  id: 'php',
  label: 'PHP',
  extension: 'php',
  syntax: 'php',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env php
<?php
// ${headline(ctx)} Needs the curl extension.

const ENDPOINT    = '${endpoint(ctx)}';
const CONTROL_KEY = '${ctx.controlKey}';
${
  shapeOf(ctx) === 'value'
    ? ''
    : `const DEGRADED_MS = ${t.degraded};
const DOWN_MS     = ${t.down};`
}

// From the environment when set, so this file is safe to commit.
$apiKey = getenv('TERN_API_KEY') ?: '${ctx.apiKey}';

/** ${measureHint(ctx)} */
function measure(): float {
${
  shapeOf(ctx) === 'value'
    ? `    $ch = curl_init('https://example.com/metrics');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_FAILONERROR    => true,
    ]);
    $body = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        throw new RuntimeException($error);
    }
    return (float) (json_decode($body, true)['pending'] ?? 0);`
    : `    $started = microtime(true);
    $ch = curl_init('https://example.com');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT_MS     => DOWN_MS,
        CURLOPT_FAILONERROR    => true,
    ]);
    $ok = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($ok === false) {
        throw new RuntimeException($error);
    }
    return (microtime(true) - $started) * 1000;`
}
}

$payload = ['controlKey' => CONTROL_KEY];

try {
${
  shapeOf(ctx) === 'value'
    ? `    $payload['value'] = measure();`
    : `    $latency = measure();
    $payload['latencyMs'] = (int) round($latency);
    $payload['status'] = $latency >= DOWN_MS ? 'down'
        : ($latency >= DEGRADED_MS ? 'degraded' : 'operational');`
}
} catch (Throwable $e) {
    $payload['status']  = 'down';
    $payload['message'] = substr($e->getMessage(), 0, 200);
}

$ch = curl_init(ENDPOINT);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json', "Authorization: Bearer {$apiKey}"],
    CURLOPT_POSTFIELDS     => json_encode($payload),
]);

$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

echo $code, ' ', $body, PHP_EOL;

if ($code < 200 || $code >= 300) {
    // Exit non-zero so cron notices a rejected push.
    exit(1);
}
exit(0);
`
  },
}

// ── 8. Perl ─────────────────────────────────────────────────────────────────

const perl: ScriptTemplate = {
  id: 'perl',
  label: 'Perl',
  extension: 'pl',
  syntax: 'perl',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env perl
# ${headline(ctx)}
# Core modules only: HTTP::Tiny and JSON::PP have shipped with Perl since 5.14.

use strict;
use warnings;
use HTTP::Tiny;
use JSON::PP;
use Time::HiRes qw(time);

my $ENDPOINT    = '${endpoint(ctx)}';
my $CONTROL_KEY = '${ctx.controlKey}';
# From the environment when set, so this file is safe to commit.
my $API_KEY     = $ENV{TERN_API_KEY} || '${ctx.apiKey}';

${
  shapeOf(ctx) === 'value'
    ? ''
    : `my $DEGRADED_MS = ${t.degraded};
my $DOWN_MS     = ${t.down};`
}

# ${measureHint(ctx)}
sub measure {
${
  shapeOf(ctx) === 'value'
    ? `    my $probe = HTTP::Tiny->new(timeout => 10);
    my $res = $probe->get('https://example.com/metrics');
    die "HTTP $res->{status} $res->{reason}\\n" unless $res->{success};
    return decode_json($res->{content})->{pending} + 0;`
    : `    my $started = time();
    my $probe = HTTP::Tiny->new(timeout => $DOWN_MS / 1000);
    my $res = $probe->get('https://example.com');
    die "HTTP $res->{status} $res->{reason}\\n" unless $res->{success};
    return (time() - $started) * 1000;`
}
}

my %payload = (controlKey => $CONTROL_KEY);

my $measured = eval { measure() };
if ($@) {
    $payload{status}  = 'down';
    $payload{message} = substr($@, 0, 200);
} else {
${
  shapeOf(ctx) === 'value'
    ? `    $payload{value} = $measured + 0;`
    : `    $payload{latencyMs} = int($measured + 0.5);
    $payload{status} = $measured >= $DOWN_MS     ? 'down'
                     : $measured >= $DEGRADED_MS ? 'degraded'
                     :                             'operational';`
}
}

my $res = HTTP::Tiny->new(timeout => 10)->request('POST', $ENDPOINT, {
    headers => {
        'Content-Type'  => 'application/json',
        'Authorization' => "Bearer $API_KEY",
    },
    content => encode_json(\\%payload),
});

print $res->{status}, ' ', ($res->{content} // ''), "\\n";

unless ($res->{success}) {
    # Exit non-zero so cron notices a rejected push.
    exit 1;
}
exit 0;
`
  },
}

// ── 9. C# / .NET ────────────────────────────────────────────────────────────

const csharp: ScriptTemplate = {
  id: 'csharp',
  label: 'C# / .NET',
  extension: 'csx',
  syntax: 'csharp',
  render(ctx) {
    const t = thresholds(ctx)
    return `// ${headline(ctx)} .NET 8, no packages.
//
//   dotnet script tern_push.csx
using System.Diagnostics;
using System.Text;
using System.Text.Json;

const string Endpoint   = "${endpoint(ctx)}";
const string ControlKey = "${ctx.controlKey}";
${
  shapeOf(ctx) === 'value'
    ? ''
    : `const int DegradedMs    = ${t.degraded};
const int DownMs        = ${t.down};`
}

// From the environment when set, so this file is safe to commit.
var apiKey = Environment.GetEnvironmentVariable("TERN_API_KEY") ?? "${ctx.apiKey}";

// ${measureHint(ctx)}
static async Task<double> MeasureAsync()
{
${
  shapeOf(ctx) === 'value'
    ? `    using var probe = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    var response = await probe.GetAsync("https://example.com/metrics");
    response.EnsureSuccessStatusCode();

    using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    return document.RootElement.GetProperty("pending").GetDouble();`
    : `    using var probe = new HttpClient { Timeout = TimeSpan.FromMilliseconds(DownMs) };
    var sw = Stopwatch.StartNew();
    var response = await probe.GetAsync("https://example.com");
    response.EnsureSuccessStatusCode();
    return sw.Elapsed.TotalMilliseconds;`
}
}

var payload = new Dictionary<string, object> { ["controlKey"] = ControlKey };

try
{
${
  shapeOf(ctx) === 'value'
    ? `    payload["value"] = await MeasureAsync();`
    : `    var latency = await MeasureAsync();
    payload["latencyMs"] = (int)Math.Round(latency);
    payload["status"] = latency >= DownMs ? "down"
        : latency >= DegradedMs ? "degraded" : "operational";`
}
}
catch (Exception error)
{
    payload["status"] = "down";
    payload["message"] = error.Message[..Math.Min(200, error.Message.Length)];
}

using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");

var content = new StringContent(JsonSerializer.Serialize(payload));
content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");

var result = await client.PostAsync(Endpoint, content);
Console.WriteLine($"{(int)result.StatusCode} {await result.Content.ReadAsStringAsync()}");

// Exit non-zero so cron notices a rejected push.
Environment.Exit(result.IsSuccessStatusCode ? 0 : 1);
`
  },
}

// ── 10. Lua ─────────────────────────────────────────────────────────────────

const lua: ScriptTemplate = {
  id: 'lua',
  label: 'Lua',
  extension: 'lua',
  syntax: 'lua',
  render(ctx) {
    const t = thresholds(ctx)
    return `#!/usr/bin/env lua
-- ${headline(ctx)}
-- Needs luasocket and lua-cjson, both common on OpenWrt and embedded devices.

local http = require("socket.http")
local https = require("ssl.https")
local ltn12 = require("ltn12")
local json = require("cjson")
local socket = require("socket")

local ENDPOINT    = "${endpoint(ctx)}"
local CONTROL_KEY = "${ctx.controlKey}"
-- From the environment when set, so this file is safe to commit.
local API_KEY     = os.getenv("TERN_API_KEY") or "${ctx.apiKey}"

${
  shapeOf(ctx) === 'value'
    ? ''
    : `local DEGRADED_MS = ${t.degraded}
local DOWN_MS     = ${t.down}`
}

-- ${measureHint(ctx)}
local function measure()
${
  shapeOf(ctx) === 'value'
    ? `  local body, code = http.request("http://example.com/metrics")
  if code ~= 200 or not body then
    return nil, "HTTP " .. tostring(code)
  end
  return tonumber(json.decode(body).pending)`
    : `  local started = socket.gettime()
  local _, code = http.request("http://example.com")
  if code ~= 200 then
    return nil, "HTTP " .. tostring(code)
  end
  return (socket.gettime() - started) * 1000`
}
end

local payload = { controlKey = CONTROL_KEY }
local measured, err = measure()

if measured then
${
  shapeOf(ctx) === 'value'
    ? `  payload.value = measured`
    : `  payload.latencyMs = math.floor(measured + 0.5)
  if measured >= DOWN_MS then
    payload.status = "down"
  elseif measured >= DEGRADED_MS then
    payload.status = "degraded"
  else
    payload.status = "operational"
  end`
}
else
  payload.status = "down"
  payload.message = tostring(err):sub(1, 200)
end

local body = json.encode(payload)
local response = {}
local transport = ENDPOINT:match("^https") and https or http

local _, code = transport.request({
  url = ENDPOINT,
  method = "POST",
  headers = {
    ["Content-Type"] = "application/json",
    ["Authorization"] = "Bearer " .. API_KEY,
    ["Content-Length"] = #body,
  },
  source = ltn12.source.string(body),
  sink = ltn12.sink.table(response),
})

print(code, table.concat(response))

if not code or code < 200 or code >= 300 then
  -- Exit non-zero so cron notices a rejected push.
  os.exit(1)
end
os.exit(0)
`
  },
}

/**
 * Ordered by how likely a given team is to reach for it first, not
 * alphabetically — the first tab should be the one most people want.
 */
export const SCRIPT_TEMPLATES: readonly ScriptTemplate[] = [
  python,
  powershell,
  bash,
  go,
  node,
  ruby,
  php,
  perl,
  csharp,
  lua,
]

export function renderTemplate(id: string, ctx: TemplateContext): string {
  const template = SCRIPT_TEMPLATES.find((t) => t.id === id)
  if (!template) throw new Error(`Unknown template: ${id}`)

  // Sections that drop out for a given payload shape leave their blank lines
  // behind. Collapsing runs of them here keeps every template free of guards
  // around its own whitespace.
  return template.render(ctx).replace(/\n{3,}/g, '\n\n')
}

export function renderAllTemplates(ctx: TemplateContext): Record<string, string> {
  // Through renderTemplate, so the whitespace tidy-up applies here too.
  return Object.fromEntries(SCRIPT_TEMPLATES.map((t) => [t.id, renderTemplate(t.id, ctx)]))
}

// ── The Rust agent ──────────────────────────────────────────────────────────

export interface AgentContext {
  baseUrl: string
  controlKey: string
  apiKey: string
  /** Seconds between runs. */
  intervalS?: number
  /**
   * The control's probe, when it has one. A push control has none, and the
   * generated file then carries a commented HTTP example rather than nothing:
   * an agent config with no probes is a service that starts and does nothing.
   */
  probe?: { type: string; [key: string]: unknown }
  degradedMs?: number
  downMs?: number
}

/**
 * The `agent.toml` for one control.
 *
 * Generated from the same place as the ten scripts, and consumed by the same
 * parser the agent uses, so what the editor shows is what `tern-agent run`
 * accepts. Keys are snake_case because that is what `config.rs` deserialises —
 * the API speaks camelCase and the conversion happens here, once.
 */
export function renderAgentConfig(ctx: AgentContext): string {
  const base = ctx.baseUrl.replace(/\/$/, '')
  const lines = [
    `server = "${base}"`,
    `api_key = "${ctx.apiKey}"`,
    `interval_s = ${ctx.intervalS ?? 60}`,
    '',
  ]

  if (!ctx.probe || ctx.probe.type === 'push') {
    lines.push(
      '# This control is fed by a push script rather than a probe, so there is',
      '# nothing here for the agent to run. Uncomment and adjust to have the',
      '# agent check it instead.',
      '#',
      '# [[probes]]',
      `# control_key = "${ctx.controlKey}"`,
      '# type = "http"',
      '# url = "https://example.com/health"',
      '#',
      '#   [[probes.assertions]]',
      '#   type = "status_code"',
      '#   eq = 200',
      '',
    )
    return lines.join('\n')
  }

  lines.push('[[probes]]', `control_key = "${ctx.controlKey}"`)

  for (const [key, value] of Object.entries(ctx.probe)) {
    // `assertions` is emitted below as its own table array, and nested objects
    // (headers) would need quoting rules this generator does not need to know.
    if (key === 'assertions' || value === undefined || value === null) continue
    if (!isEmittable(value)) continue
    lines.push(`${snake(key)} = ${literal(value)}`)
  }

  const assertions = Array.isArray(ctx.probe.assertions) ? ctx.probe.assertions : []
  const derived = assertions.length > 0 ? assertions : defaultAssertions(ctx)

  for (const assertion of derived) {
    if (typeof assertion !== 'object' || assertion === null) continue
    lines.push('', '  [[probes.assertions]]')
    for (const [key, value] of Object.entries(assertion as Record<string, unknown>)) {
      if (value === undefined || value === null || !isEmittable(value)) continue
      lines.push(`  ${snake(key)} = ${literal(value)}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * What to assert when the control has no assertions of its own.
 *
 * A probe with an empty assertion list reports "up" for anything that answers,
 * including a 500. The thresholds already configured on the control are the
 * closest thing to the operator's own intent, so they are used.
 */
function defaultAssertions(ctx: AgentContext): Record<string, unknown>[] {
  const assertions: Record<string, unknown>[] = []

  if (ctx.probe?.type === 'http') {
    assertions.push({ type: 'status_code', range: [200, 299] })
  }
  if (ctx.downMs) {
    assertions.push({ type: 'latency', ms: ctx.downMs, severity: 'down' })
  }
  if (ctx.degradedMs) {
    assertions.push({ type: 'latency', ms: ctx.degradedMs, severity: 'degraded' })
  }
  return assertions
}

/** The pairing command, with the PIN the admin just generated. */
export function renderAgentPairCommand(baseUrl: string, pin?: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return `tern-agent pair --server ${base} --pin ${pin ?? '<PIN>'}`
}

export function renderAgentRunCommand(): string {
  return 'tern-agent run --config agent.toml'
}

/**
 * Scalars and arrays of scalars.
 *
 * Arrays matter: `status_code` carries `range = [200, 299]`, and dropping it
 * emits an assertion that constrains nothing while looking like it does. Nested
 * tables (HTTP headers) are left out deliberately — they would need quoting
 * rules this generator has no reason to know, and the operator adds them by hand.
 */
function isEmittable(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => item !== null && !isObject(item))
  return !isObject(value)
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function literal(value: unknown): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  return `"${String(value)}"`
}
