#!/usr/bin/env python3
"""暗夜突围 - 全国排行榜 API 服务"""
import json, os, time, hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

DATA_FILE = '/data/hermes/zn-promo/zn-promo/NightBreak/rank_data.json'
PORT = 8001

def load_rank():
    try:
        with open(DATA_FILE, 'r') as f:
            return json.load(f)
    except: return []

def save_rank(data):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def calc_score(level, kills, time_val):
    return level * 1000 + kills * 50 + int(time_val)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/rank':
            qs = parse_qs(parsed.query)
            page = int(qs.get('page', [1])[0])
            limit = int(qs.get('limit', [20])[0])
            data = load_rank()
            # Sort by score descending
            data.sort(key=lambda x: x.get('score', 0), reverse=True)
            total = len(data)
            start = (page - 1) * limit
            end = start + limit
            page_data = data[start:end]
            # Add rank number
            for i, item in enumerate(page_data):
                item['rank'] = start + i + 1
            self.send_json({
                'code': 0,
                'data': page_data,
                'total': total,
                'page': page,
                'limit': limit,
                'pages': (total + limit - 1) // limit if total > 0 else 1
            })
        elif parsed.path == '/api/rank/check':
            self.send_json({'code': 0, 'data': {'status': 'ok'}})
        else:
            self.send_json({'code': -1, 'msg': 'not found'}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length > 0 else b'{}'
        try:
            data = json.loads(body)
        except:
            self.send_json({'code': -1, 'msg': 'invalid json'}, 400)
            return

        if parsed.path == '/api/rank/submit':
            name = str(data.get('name', '匿名玩家'))[:20]
            level = int(data.get('level', 0))
            kills = int(data.get('kills', 0))
            time_val = int(data.get('time', 0))
            wave = int(data.get('wave', 0))
            score = calc_score(level, kills, time_val)
            
            # Generate player ID from name + timestamp
            pid = hashlib.md5((name + str(time.time())).encode()).hexdigest()[:8]
            
            entry = {
                'id': pid,
                'name': name,
                'score': score,
                'level': level,
                'kills': kills,
                'time': time_val,
                'wave': wave,
                'date': int(time.time())
            }
            
            rank = load_rank()
            # Check if same name already exists, keep higher score
            exists = False
            for i, e in enumerate(rank):
                if e.get('name') == name:
                    if score > e.get('score', 0):
                        rank[i] = entry
                    exists = True
                    break
            if not exists:
                rank.append(entry)
            
            # Keep top 1000
            rank.sort(key=lambda x: x.get('score', 0), reverse=True)
            rank = rank[:1000]
            save_rank(rank)
            
            # Find player's rank
            player_rank = 1
            for i, e in enumerate(rank):
                if e.get('id') == pid or (e.get('name') == name and e.get('score') == score):
                    player_rank = i + 1
                    break
            
            # Check if score is high enough to be top 100
            top100 = len(rank) >= 100 and score >= rank[99].get('score', 0) if len(rank) >= 100 else True
            
            self.send_json({
                'code': 0,
                'data': {
                    'id': pid,
                    'score': score,
                    'rank': player_rank,
                    'total': len(rank),
                    'top100': top100 or player_rank <= 100
                }
            })
        else:
            self.send_json({'code': -1, 'msg': 'not found'}, 404)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress logs

if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'Rank API server running on port {PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()