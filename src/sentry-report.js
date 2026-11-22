const EXPECTED_ERROR_PATTERNS = [
  /invalid (?:download options|quality|start time|end time)/i,
  /not a valid url|please enter a valid url/i,
  /unsupported url|url type isn't supported|isn't supported via this method/i,
  /private|requires? login|age.?restrict/i,
  /unavailable|removed|deleted|not available in your (?:country|region)/i,
  /rate.?limit|http error 429|429 too many requests/i,
  /network error|timed out|connection|couldn't reach|check your internet|certificate|ssl/i,
  /disk (?:space|is almost full)|not enough disk|cannot (?:save|write)/i,
  /download cancelled|request timed out/i,
  /live streams? can(?:not|'t) be clipped/i,
];

const PLATFORM_ERROR_PATTERNS = [
  /nsig|signature extraction|cipher|player.*error/i,
  /extractor(?:error|.*failed)|unable to extract/i,
  /yt-dlp (?:is )?outdated|can't decrypt/i,
  /module(?:notfound)?error|importerror|traceback/i,
  /yt-dlp binary is corrupted|unable to download webpage/i,
  /platform rejected this video stream|http error 403|403 forbidden/i,
  /youtube challenge support|playback session|unsupported stream/i,
];

const EXPECTED_REASON_CODES = new Set([
  'age_restricted',
  'certificate_error',
  'disk_full',
  'incomplete_download',
  'invalid_url',
  'login_required',
  'network_error',
  'private_content',
  'rate_limited',
  'region_blocked',
  'tiktok_challenge',
  'unavailable',
  'unsupported_url',
]);

const PLATFORM_REASON_CODES = new Set([
  'access_forbidden',
  'engine_corrupt',
  'extractor_regression',
  'js_runtime_missing',
  'platform_unreachable',
  'po_token_required',
  'sabr_only',
]);

const SENSITIVE_KEY = /(?:^|_)(?:url|uri|path|filepath|clipboard|history|project|username|email)(?:$|_)/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const FILE_URL_PATTERN = /\bfile:\/\/\/[^\s"'<>]+/gi;
const MAC_USER_PATTERN = /\/Users\/[^/\s]+/g;
const UNIX_HOME_PATTERN = /\/home\/[^/\s]+/g;
const WINDOWS_USER_PATTERN = /[A-Za-z]:\\Users\\[^\\\s]+/g;

let sentry = null;

function configureSentryReporting(client) {
  sentry = client;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return String(error?.message || error || 'Unknown error');
}

function classifyError(error) {
  const message = errorMessage(error);
  if (EXPECTED_ERROR_PATTERNS.some(pattern => pattern.test(message))) return 'expected';
  if (PLATFORM_ERROR_PATTERNS.some(pattern => pattern.test(message))) return 'platform';
  return 'bug';
}

function classifyReasonCode(reasonCode, error) {
  if (EXPECTED_REASON_CODES.has(reasonCode)) return 'expected';
  if (PLATFORM_REASON_CODES.has(reasonCode)) return 'platform';
  return classifyError(error);
}

function scrubString(value) {
  return value
    .replace(FILE_URL_PATTERN, '[Filtered file URL]')
    .replace(URL_PATTERN, '[Filtered URL]')
    .replace(MAC_USER_PATTERN, '/Users/[Filtered]')
    .replace(UNIX_HOME_PATTERN, '/home/[Filtered]')
    .replace(WINDOWS_USER_PATTERN, 'C:\\Users\\[Filtered]');
}

function scrubValue(value, key = '', depth = 0) {
  if (depth > 8) return '[Filtered: depth]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key)) return '[Filtered]';
    if (key === 'filename') {
      return value
        .replace(MAC_USER_PATTERN, '/Users/[Filtered]')
        .replace(UNIX_HOME_PATTERN, '/home/[Filtered]')
        .replace(WINDOWS_USER_PATTERN, 'C:\\Users\\[Filtered]');
    }
    return scrubString(value);
  }
  if (Array.isArray(value)) return value.map(item => scrubValue(item, '', depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(childKey)) {
        output[childKey] = '[Filtered]';
      } else {
        output[childKey] = scrubValue(childValue, childKey, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}

function scrubSentryEvent(event) {
  const scrubbed = scrubValue(event);
  delete scrubbed.user;
  if (scrubbed.request) {
    delete scrubbed.request.cookies;
    delete scrubbed.request.headers;
    delete scrubbed.request.data;
    delete scrubbed.request.query_string;
    scrubbed.request.url = '[Filtered]';
  }
  return scrubbed;
}

function safeTag(value, fallback = 'unknown') {
  const normalized = String(value || fallback).toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return normalized.slice(0, 64) || fallback;
}

function fingerprintFor(classification, context = {}) {
  if (classification !== 'platform') return undefined;
  return [
    'downroad-platform',
    safeTag(context.platform),
    safeTag(context.phase),
  ];
}

function reportError(error, context = {}) {
  const classification = context.reasonCode
    ? classifyReasonCode(context.reasonCode, error)
    : classifyError(error);
  if (!sentry || classification === 'expected') return null;

  const exception = error instanceof Error ? error : new Error(errorMessage(error));
  return sentry.withScope(scope => {
    scope.setLevel(classification === 'platform' ? 'warning' : 'error');
    scope.setTag('error_class', classification);
    scope.setTag('platform', safeTag(context.platform));
    scope.setTag('phase', safeTag(context.phase));
    if (context.mediaType) scope.setTag('media_type', safeTag(context.mediaType));
    if (context.quality) scope.setTag('quality', safeTag(context.quality));
    if (context.ytdlpVersion) scope.setTag('ytdlp_version', safeTag(context.ytdlpVersion));
    if (context.ytdlpChannel) scope.setTag('ytdlp_channel', safeTag(context.ytdlpChannel));
    if (context.reasonCode) scope.setTag('reason_code', safeTag(context.reasonCode));
    if (context.httpStatus) scope.setTag('http_status', safeTag(context.httpStatus));
    if (context.architecture) scope.setTag('architecture', safeTag(context.architecture));

    const fingerprint = fingerprintFor(classification, context);
    if (fingerprint) scope.setFingerprint(fingerprint);
    if (context.details) scope.setContext('failure', scrubValue(context.details));

    return sentry.captureException(exception);
  });
}

function addBreadcrumb(message, context = {}) {
  if (!sentry) return;
  sentry.addBreadcrumb({
    category: 'downroad',
    message,
    level: 'info',
    data: scrubValue(context),
  });
}

module.exports = {
  addBreadcrumb,
  classifyError,
  classifyReasonCode,
  configureSentryReporting,
  errorMessage,
  fingerprintFor,
  reportError,
  scrubSentryEvent,
  scrubString,
  scrubValue,
};
