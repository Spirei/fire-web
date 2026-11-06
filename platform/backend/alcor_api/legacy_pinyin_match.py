"""Boolean pinyin-match 1.2.10 simplified search, without enumerating word breaks.

The upstream core uses NFD (not compatibility decomposition), JS whitespace and
UTF-16 characters. Dictionary/license are bundled beside this module. Ranges are
not exposed: callers require only the original match result's truthiness.
"""

import json
import re
import unicodedata
from functools import cache, lru_cache
from pathlib import Path

# ECMAScript WhiteSpace + LineTerminator; unlike Python \s this excludes U+0085.
SPACE = re.compile('[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+')


def units(value):
    encoded=value.encode('utf-16-le',errors='surrogatepass')
    return tuple(chr(encoded[index]+256*encoded[index+1]) for index in range(0,len(encoded),2))


@lru_cache(maxsize=1)
def dictionary():
    source=json.loads((Path(__file__).parent/'data/pinyin_match_simplified.json').read_text(encoding='utf-8'))
    handled={}
    uv={'ju','jun','jue','juan','qu','qun','que','xuan','xu','xue','yu','yuan','yue','yun','nve','lve'}
    for key,chars in source.items():
        handled[key]=chars
        if key in uv:
            handled[key.replace('u','v',1) if 'u' in key else key.replace('v','u',1)]=chars
        if key in ('lv','lve','nv','nve'):
            handled[key.replace('v','ü')]=chars
    by_char={}
    for syllable,chars in handled.items():
        for char in units(chars):
            by_char.setdefault(char,set()).add(syllable)
    syllables=frozenset(handled)
    prefixes=frozenset(sound[:end] for sound in syllables for end in range(1,len(sound)+1))
    return by_char,syllables,prefixes


def plain(value):
    return ''.join(char for char in unicodedata.normalize('NFD',value.lower()) if not '\u0300'<=char<='\u036f')


def matches(text,query):
    if not isinstance(text,str) or not isinstance(query,str) or not text or not query:
        return False
    # Upstream replaces only the first ü, before removing combining marks.
    query=SPACE.sub('',query).lower()
    if any(value in query for value in ('lü','lüe','nü','nüe')):
        query=query.replace('ü','v',1)
    query,text=plain(query),plain(text)
    if query in text:
        return True
    # getIndex skips literal U+0020 in the input; other whitespace is retained.
    text=text.replace(' ','')
    if query in text:
        return True
    by_char,syllables,prefixes=dictionary()
    query_units=units(query)
    sounds=tuple(by_char.get(char,frozenset((char,))) for char in units(text))
    # getFullKey always supplies the character/initial fallback, or an equivalent
    # all-single-letter word break with extend=true. It cannot mix initials and
    # complete syllables inside a multi-character syllable word break.
    for start in range(len(sounds)-len(query_units)+1):
        if all(any(sound.startswith(char) for sound in sounds[start+index]) for index,char in enumerate(query_units)):
            return True

    @cache
    def visit(at,offset):
        if at>=len(sounds):
            return False
        rest=''.join(query_units[offset:])
        # A final abbreviated syllable must itself prefix a dictionary syllable.
        # In particular han1 is not a legal word break, even for input 汉1.
        if rest in prefixes and any(sound.startswith(rest) for sound in sounds[at]):
            return True
        return any(sound in syllables and rest.startswith(sound) and len(sound)<len(rest)
                   and visit(at+1,offset+len(sound)) for sound in sounds[at])

    return any(visit(start,0) for start in range(len(sounds)))
