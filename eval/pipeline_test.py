#!/usr/bin/env python3
"""python3 -I eval/pipeline_test.py <model> <tag> [lesson_ids]
Runs, for the given model: (a) single-pass v9, (b) two-stage v4 (facts dump) -> v10 (synthesis).
Outputs: eval/out/<tag>-single/<lesson>.md, eval/out/<tag>-2stage/<lesson>.md (+ <lesson>.dump.md)."""
import importlib.util, os, re, sys, time
sys.path.insert(0, str(Path(__file__).resolve().parent)) if False else None
from pathlib import Path
HERE = Path(__file__).resolve().parent
from mathesis import coverage as cov  # packaged module (run with the project venv)
sp = importlib.util.spec_from_file_location('ev', HERE / 'evaluate.py'); ev = importlib.util.module_from_spec(sp); sp.loader.exec_module(ev)
model, tag = sys.argv[1], sys.argv[2]
ids = sys.argv[3].split(',') if len(sys.argv) > 3 else ['23-vpc', '13-slos']
P = lambda n: (HERE / 'prompts' / n).read_text()
S1 = os.environ.get('STAGE1', 'v4'); S2 = os.environ.get('STAGE2', 'v10'); SINGLE = os.environ.get('SINGLE', '1') == '1'
def ctx(lid):
    p = ev.ROOT / ev.FACTS['lessons'][lid]['file']
    return dict(learning_path=p.parent.parent.name, course=p.parent.name, lesson=re.sub(r'^\d+-', '', p.stem))
for lid in ids:
    t0 = time.time()
    tr = ev.transcript_of(ev.FACTS['lessons'][lid]); c = ctx(lid)
    for d in ('single', '2stage'):
        (ev.OUT_ROOT / f'{tag}-{d}').mkdir(parents=True, exist_ok=True)
    single = ''
    if SINGLE:
        single = ev.chat(model, P('v9.txt'), P('v9.user.txt').format(content=tr, **c))
        (ev.OUT_ROOT / f'{tag}-single' / f'{lid}.md').write_text(single + '\n')
    t1 = time.time()
    dump = ev.chat(model, P(S1 + '.txt'), P(S1 + '.user.txt').format(content=tr, **c))
    (ev.OUT_ROOT / f'{tag}-2stage' / f'{lid}.dump.md').write_text(dump + '\n')
    two = ev.chat(model, P(S2 + '.txt'), P(S2 + '.user.txt').format(content=dump, **c))
    revisions = 0
    for _ in range(int(os.environ.get('REVISE', '0'))):
        miss, secs = cov.missing_facts(dump, two), cov.required_sections_missing(two)
        if not miss and not secs:
            break
        msg = 'CURRENT NOTES:\n' + two + '\n\nOMITTED FACTS:\n' + '\n'.join('- ' + m for m in miss) + ('\n\nMISSING SECTIONS: ' + ', '.join(secs) if secs else '')
        two = ev.chat(model, P('revise.txt'), msg); revisions += 1
    (ev.OUT_ROOT / f'{tag}-2stage' / f'{lid}.md').write_text(two + '\n')
    print(f'{tag} {lid}: revisions={revisions} | single {len(single.split())}w ({t1 - t0:.0f}s) | 2-stage {len(two.split())}w ({time.time() - t1:.0f}s)', flush=True)
