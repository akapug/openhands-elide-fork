import os
import time
import json
from flask import Flask, Response, request, jsonify

app = Flask(__name__)


@app.get('/healthz')
def healthz():
    return Response('ok\n', mimetype='text/plain')


def _spin(ms: int):
    if ms <= 0:
        return
    end = time.perf_counter() + (ms / 1000.0)
    while time.perf_counter() < end:
        pass


@app.post('/tool')
def tool():
    try:
        body = request.get_json(silent=True) or {}
        cpu_spin_ms = int(body.get('cpu_spin_ms', os.getenv('SYN_CPU_SPIN_MS', 0)))
        if cpu_spin_ms > 0:
            _spin(cpu_spin_ms)
        return jsonify({ 'ok': True })
    except Exception as e:
        return jsonify({ 'error': str(e) }), 500


@app.post('/api/chat/completions')
def chat():
    body = request.get_json(silent=True) or {}
    frames = int(body.get('frames', os.getenv('SYN_FRAMES', 200)))
    delay_ms = int(body.get('delay_ms', os.getenv('SYN_DELAY_MS', 5)))
    bytes_per_frame = int(body.get('bytes_per_frame', os.getenv('SYN_BYTES', 64)))
    cpu_spin_ms = int(body.get('cpu_spin_ms', os.getenv('SYN_CPU_SPIN_MS', 0)))
    fanout = int(body.get('fanout', os.getenv('SYN_FANOUT', 0)))
    fanout_delay_ms = int(body.get('fanout_delay_ms', os.getenv('SYN_FANOUT_DELAY_MS', 0)))
    fanout_http = str(os.getenv('SYN_FANOUT_HTTP', '')).lower() in ('1', 'true')

    word = 'x'
    words_per_frame = max(1, bytes_per_frame // (len(word) + 1))

    def generate():
        # Pre-stream fanout
        if fanout > 0:
            if fanout_http:
                import requests  # lazy import
                for _ in range(fanout):
                    if fanout_delay_ms > 0:
                        time.sleep(fanout_delay_ms / 1000.0)
                    try:
                        requests.post('http://127.0.0.1:8083/tool', json={'cpu_spin_ms': cpu_spin_ms}, timeout=5.0)
                    except Exception:
                        pass
            else:
                for _ in range(fanout):
                    if fanout_delay_ms > 0:
                        time.sleep(fanout_delay_ms / 1000.0)
                    if cpu_spin_ms > 0:
                        _spin(cpu_spin_ms)

        for _ in range(frames):
            if cpu_spin_ms > 0:
                _spin(cpu_spin_ms)
            text = (word + ' ') * words_per_frame
            payload = { 'choices': [{ 'delta': { 'content': text } }] }
            yield ('data: ' + json.dumps(payload) + '\n\n').encode('utf-8')
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)
        yield b'data: [DONE]\n\n'

    return Response(generate(), mimetype='text/event-stream')


# Non-streaming micro endpoints for wrk2 and microbenchmarks
@app.get('/micro/plain')
def micro_plain():
    try:
        bytes_count = max(1, int(request.args.get('bytes', '32')))
        buf = (b'x' * bytes_count)
        return Response(buf, mimetype='text/plain', headers={'content-length': str(len(buf))})
    except Exception as e:
        return Response(str(e), status=500, mimetype='text/plain')


@app.get('/micro/chunked')
def micro_chunked():
    try:
        bytes_per = max(1, int(request.args.get('bytes', '32')))
        chunks = max(1, int(request.args.get('chunks', '1')))
        delay_ms = max(0, int(request.args.get('delay_ms', '0')))
        word = (b'x' * bytes_per)

        def gen():
            for _ in range(chunks):
                yield word
                if delay_ms > 0:
                    time.sleep(delay_ms / 1000.0)
        return Response(gen(), mimetype='application/octet-stream')
    except Exception as e:
        return Response(str(e), status=500, mimetype='text/plain')


if __name__ == '__main__':
    # For local debug: python app/main.py
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '8083'))) 

