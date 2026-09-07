"""Read only scoped game diagnostics; optional repair preserves existing origins."""
import collections
import json
import os
import re
import subprocess

BUCKET = 'easygame7-audio-d81bb227-42b6a9'
ORIGIN = 'https://xn--80aadskjyjbavcy.xn--p1ai'
FOLDER = 'b1gtc579k8imd81bb227'


def yc(*args):
    result = subprocess.run(['yc', *args, '--folder-id', FOLDER, '--format', 'json'], capture_output=True, text=True)
    if result.returncode:
        # Never publish raw cloud responses, environment values, tokens, or user logs.
        print(json.dumps({'command': list(args[:3]), 'failed': True, 'permission_denied': 'PermissionDenied' in result.stderr}))
        return None
    return json.loads(result.stdout or '{}')


bucket = yc('storage', 'bucket', 'get', '--name', BUCKET)
if bucket is None:
    raise SystemExit(1)
print(json.dumps({'audio_bucket': {key: bucket.get(key) for key in ('name', 'cors', 'lifecycle_rules', 'anonymous_access_flags')}}))
if os.environ.get('REPAIR_AUDIO_CORS') == 'true':
    origins = {ORIGIN}
    for rule in bucket.get('cors', []):
        origins.update(rule.get('allowed_origins', []))
    rule = 'allowed-methods=[method-get,method-put,method-head],allowed-origins=[' + ','.join(sorted(origins)) + '],allowed-headers=[content-type],expose-headers=[etag],max-age-seconds=600'
    if yc('storage', 'bucket', 'update', '--name', BUCKET, '--cors', rule) is None:
        raise SystemExit(1)
    bucket = yc('storage', 'bucket', 'get', '--name', BUCKET)
    print(json.dumps({'repaired_audio_cors': bucket.get('cors')}))

revisions = yc('serverless', 'container', 'revision', 'list', '--container-id', 'bba4u5rl3fimpjhbrrqo')
if revisions:
    for revision in revisions[:3]:
        image = revision.get('image', {})
        environment = image.get('environment', {})
        print(json.dumps({'revision': {key: revision.get(key) for key in ('id', 'status', 'created_at', 'concurrency', 'execution_timeout')}, 'image': image.get('image_url'), 'allowed_origins': environment.get('ALLOWED_ORIGINS')}))

logs = yc('logging', 'read', '--group-id', 'e23povritvkp4nnsn3pq', '--since', '24h', '--limit', '1000')
if logs is not None:
    entries = logs if isinstance(logs, list) else logs.get('entries', [])
    levels = collections.Counter(item.get('level', 'unknown') for item in entries)
    statuses = collections.Counter()
    exceptions = collections.Counter()
    for item in entries:
        message = item.get('message', '')
        statuses.update(re.findall(r'HTTP/1\.[01]"\s+(\d{3})', message))
        exceptions.update(re.findall(r'\b([A-Za-z]+(?:Error|Exception))\b', message))
    print(json.dumps({'log_sample': len(entries), 'levels': dict(levels), 'http_statuses': dict(statuses), 'exception_classes': dict(exceptions)}))
