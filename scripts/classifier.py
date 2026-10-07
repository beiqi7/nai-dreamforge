#!/usr/bin/env python3
"""
classifier.py — NovelAI 生成图作品与角色提取分类器
分类原则：
1. 所有生成的图片全部备份上传，不遗漏任何一张。
2. 分类只按照【女性角色】建目录归档。
3. 若图片包含女性角色（如 1girl 或男女互动），一律提取对应的女角色及所属作品建目录，剔除男角色标签。
4. 若为无明显指定女角色（纯男、纯景、抽象等），统一归入 "Other_Generations" 目录备存。
"""

import os
import sys
import struct
import json
import re
import sqlite3

def read_png_metadata(filepath):
    chunks = {}
    try:
        with open(filepath, 'rb') as f:
            sig = f.read(8)
            if sig != b'\x89PNG\r\n\x1a\n':
                return None
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    break
                length, chunk_type = struct.unpack('>I4s', hdr)
                data = f.read(length)
                f.read(4)
                name = chunk_type.decode('latin1', errors='ignore')
                if name == 'tEXt':
                    parts = data.split(b'\x00', 1)
                    if len(parts) == 2:
                        chunks[parts[0].decode('latin1', errors='ignore')] = parts[1].decode('utf-8', errors='ignore')
                elif name == 'iTXt':
                    parts = data.split(b'\x00', 5)
                    if len(parts) >= 5:
                        chunks[parts[0].decode('latin1', errors='ignore')] = parts[-1].decode('utf-8', errors='ignore')
        return chunks
    except Exception:
        return None

def clean_tag(s):
    # 仅允许文字、数字、空格、下划线、连字符和单引号；明确移除路径组件符号。
    s = re.sub(r"[^\w \-']+", '_', str(s).strip(), flags=re.UNICODE)
    s = s.strip(" ._-")
    return s if s and s not in {'.', '..'} else 'Unknown'

# 陪衬或男性相关关键词（不作为角色目录名）
MALE_IGNORE_KEYWORDS = {
    'faceless male', 'fat man', 'obese male', 'chinese man', 'university student',
    'beer belly', 'fat belly', 'old man', 'ugly bastard', 'shota', '1boy', '2boys', '3boys',
    'males', 'men', 'father', 'brother', 'boy', 'guy', 'monster', 'tentacles', '肥猪', '肥猪better'
}

class CharacterClassifier:
    def __init__(self, db_path=None):
        project_db = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'nai.sqlite')
        self.db_path = db_path or os.environ.get('NAI_DB') or project_db
        self.db_map = {}
        self.lib_female_chars = []
        self._load_data()

    def _load_data(self):
        if not os.path.exists(self.db_path):
            return
        try:
            conn = sqlite3.connect(self.db_path)
            conn.execute('PRAGMA query_only = ON')
            for f, p, cp in conn.execute("SELECT file, prompt, char_prompts FROM generations WHERE file IS NOT NULL"):
                self.db_map[f] = {'prompt': p or '', 'char_prompts': cp or ''}

            for title, content in conn.execute("SELECT title, content FROM prompt_library WHERE kind='character'"):
                # 排除纯男角色预设
                if any(m in title.lower() for m in ['肥猪', '男', 'male', 'boy']):
                    continue

                try:
                    cd = json.loads(content)
                    prompt_str = cd.get('prompt', '')
                except Exception:
                    prompt_str = content

                parts = title.split('|')
                series = parts[0].strip() if len(parts) > 1 else 'Other'
                name = parts[1].strip() if len(parts) > 1 else title.strip()

                tags = []
                for t in prompt_str.split(','):
                    t = t.strip().lower()
                    if t and not t.startswith(('1girl', '1boy', 'solo', 'girl', 'boy')):
                        tags.append(t)

                self.lib_female_chars.append({
                    'series': series,
                    'name': name,
                    'tags': tags
                })
            conn.close()
        except Exception as e:
            sys.stderr.write(f"[classifier] DB load error: {e}\n")

    def classify(self, filepath):
        """
        所有图片都会返回一个目录路径 (series_dir, char_dir)。
        优先匹配女性角色；无女角色则回退到 Other_Generations 统一保存。
        """
        filename = os.path.basename(filepath)
        meta = read_png_metadata(filepath) or {}

        png_prompt = ''
        if 'Comment' in meta:
            try:
                c_json = json.loads(meta['Comment'])
                png_prompt = c_json.get('prompt', '')
            except Exception:
                pass
        if not png_prompt:
            png_prompt = meta.get('Description', '')

        db_rec = self.db_map.get(filename, {})
        db_prompt = db_rec.get('prompt', '')
        db_chars = db_rec.get('char_prompts', '')

        combined = (png_prompt + " " + db_prompt).lower()

        # 策略 1: 优先检查多角色框 char_prompts 中是否标有女角色
        if db_chars and db_chars != '[]':
            try:
                char_list = json.loads(db_chars)
                if isinstance(char_list, list) and len(char_list) > 0:
                    for item in char_list:
                        raw_p = item.get('prompt', '').strip()
                        raw_low = raw_p.lower()
                        # 跳过纯男框
                        if any(mk in raw_low for mk in MALE_IGNORE_KEYWORDS) and not any(fk in raw_low for fk in ['girl', 'female', 'woman']):
                            continue
                        
                        m = re.search(r'([a-zA-Z0-9_\-\s\.\']+)\s*\(([^)]+)\)', raw_p)
                        if m:
                            name = m.group(1).replace('1girl,', '').replace('1boy,', '').strip().replace('_', ' ').title()
                            series = m.group(2).strip().replace('_', ' ').title()
                            return clean_tag(series), clean_tag(name)
                        else:
                            cleaned = re.sub(r'^(1girl|girl|female)[,\s]*', '', raw_p, flags=re.I).strip()
                            if cleaned and len(cleaned) > 1 and cleaned.lower() not in MALE_IGNORE_KEYWORDS:
                                return "Custom", clean_tag(cleaned.replace('_', ' ').title())
            except Exception:
                pass

        # 策略 2: 匹配预设女性角色库 (260+位)
        for item in self.lib_female_chars:
            for tag in item['tags']:
                if tag and tag in combined:
                    return clean_tag(item['series']), clean_tag(item['name'])

        # 策略 3: Danbooru 格式 name_(series) 提取女角色
        exclude_series = {
            'meshia8787', 'momopoco', 'hitenkei', 'artist', 'style', 'op-center',
            'full', 'curated', 'genshin', 'anime', 'comic', 'manga', 'pixiv',
            'twitter', 'official', 'danbooru', 'civitai'
        }
        matches = re.findall(r'([a-zA-Z0-9_\-\.\']+)\s*\(([^)]+)\)', combined)
        for name, series in matches:
            s_clean = series.strip().lower()
            n_clean = name.strip().lower()
            if s_clean in exclude_series or len(s_clean) <= 2:
                continue
            if any(mk in n_clean for mk in MALE_IGNORE_KEYWORDS):
                continue

            series_title = series.replace('_', ' ').strip().title()
            char_title = name.replace('_', ' ').strip().title()
            return clean_tag(series_title), clean_tag(char_title)

        # 策略 4: 如果有女性标志但未识别出具体角色名 -> 归入 Original_Female
        has_female_hint = any(k in combined for k in ['1girl', '2girls', '3girls', 'girl', 'female', 'woman', 'women', 'breasts', 'pussy'])
        if has_female_hint:
            return "Original_Female", "General"

        # 策略 5: 纯男/纯景/无女性特征的图 -> 依然备份，统一存放到 Other_Generations
        return "Other_Generations", "General"

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 classifier.py <image_path>")
        sys.exit(1)
    target = sys.argv[1]
    cls = CharacterClassifier()
    s, c = cls.classify(target)
    print(f"{s}/{c}")
