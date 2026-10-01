#!/usr/bin/env python3
"""Validate a PostgreSQL archive and export ONLY Rhythmeta migration data.
Never connects to PostgreSQL, Cloudflare, or a production database. Output contains
credentials: keep the output directory private and outside version control.
"""
import argparse, csv, datetime, hashlib, io, json, os, re, sqlite3, subprocess
from pathlib import Path

TABLES = ['users','user_totp_credentials','user_passkey_credentials','user_mfa_backup_codes','aliases','community_alias_candidates','community_alias_votes']
def unescape(value):
    if value == r'\N': return None
    translations={'b':'\b','f':'\f','n':'\n','r':'\r','t':'\t','v':'\v','\\':'\\'}
    return re.sub(r'\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)',lambda m: chr(int(m[1],8)) if re.fullmatch('[0-7]{1,3}',m[1]) else chr(int(m[1][1:],16)) if m[1].startswith('x') and len(m[1])>1 else translations.get(m[1],m[1]),value)
def postgres_array(value):
    if value=='{}':return []
    return next(csv.reader([value[1:-1]],escapechar='\\'))
def literal(value):
    if value is None:return 'NULL'
    if isinstance(value,bytes):return "X'"+value.hex()+"'"
    if isinstance(value,int):return str(value)
    return "'"+str(value).replace("'","''")+"'"
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive',type=Path)
    parser.add_argument('--env-file',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=Path('.migration'))
    parser.add_argument('--pg-restore',default='pg_restore')
    args=parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True,exist_ok=True);args.output.chmod(0o700)
    env={}
    for line in args.env_file.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key,value=line.split('=',1);env[key.strip()]=value.strip().strip('\"\'')
    for key in ['OPAQUE_SERVER_SETUP','WEBAUTHN_RP_ID']:
        if not env.get(key):raise SystemExit('Missing required production setting: '+key)
    subprocess.run([args.pg_restore,'--file=/dev/null',str(args.archive)],check=True)
    sql_path=args.output/'data.sql'; sqlite_path=args.output/'rehearsal.sqlite'
    if sql_path.exists() or sqlite_path.exists():raise SystemExit('Output already exists; use a fresh output directory.')
    db=sqlite3.connect(sqlite_path)
    db.executescript((Path(__file__).resolve().parents[1]/'migrations/0001_rhythmeta.sql').read_text())
    columns={table:{row[1]:row[2] for row in db.execute('PRAGMA table_info('+table+')')} for table in TABLES}
    cmd=[args.pg_restore,'--file=-','--data-only','--no-owner','--no-privileges']
    for table in TABLES:cmd+=['--table',table]
    cmd.append(str(args.archive))
    proc=subprocess.Popen(cmd,stdout=subprocess.PIPE,text=True,encoding='utf-8')
    counts={table:0 for table in TABLES};rows={table:[] for table in TABLES}
    current=None
    for line in proc.stdout:
        match=re.match(r'COPY public\.(\w+) \((.+)\) FROM stdin;',line)
        if match:
            current=match[1];names=[x.strip().strip('"') for x in match[2].split(',')];continue
        if current is None:continue
        if line.rstrip('\n')==r'\.':current=None;continue
        values=line.rstrip('\n').split('\t')
        if len(values)!=len(names):raise SystemExit('Invalid COPY column count for '+current)
        row=dict(zip(names,map(unescape,values)))
        if current=='aliases' and row.get('source')!='community':continue
        if current in ['aliases','community_alias_candidates']:row['game']='maimaid'
        if current=='user_passkey_credentials':
            row['rpId']=env['WEBAUTHN_RP_ID']
            row['transports']=json.dumps(postgres_array(row['transports']))
            if not row['publicKey'].startswith('\\x'):raise SystemExit('Unexpected public key encoding')
            row['publicKey']=bytes.fromhex(row['publicKey'][2:])
        row={key:value for key,value in row.items() if key in columns[current]}
        for key,value in row.items():
            if value is None:continue
            if columns[current][key]=='INTEGER':row[key]=1 if value=='t' else 0 if value=='f' else int(value)
            elif key.endswith('At'):
                normalized=re.sub(r'([+-]\d{2})$',r'\1:00',value.replace(' ','T').replace('Z','+00:00'))
                normalized=re.sub(r'\.(\d+)',lambda m:'.'+m[1].ljust(6,'0'),normalized)
                dt=datetime.datetime.fromisoformat(normalized)
                if dt.tzinfo is None:dt=dt.replace(tzinfo=datetime.timezone.utc)
                row[key]=dt.astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            elif key=='submittedLocalDate':row[key]=value[:10]
        rows[current].append(row)
    if proc.wait()!=0:raise SystemExit('pg_restore failed')
    with sql_path.open('x') as output:
        output.write('-- Sensitive migration data. Generated from a verified PostgreSQL archive.\n')
        for table in TABLES:
            for row in rows[table]:
                keys=list(row)
                quoted=','.join('"'+key+'"' for key in keys)
                db.execute('INSERT INTO '+table+' ('+quoted+') VALUES ('+','.join('?' for _ in keys)+')',list(row.values()))
                output.write('INSERT INTO '+table+' ('+quoted+') VALUES ('+','.join(literal(v) for v in row.values())+');\n')
                counts[table]+=1
    # Historical rejected candidates are tombstones for clients that cached old aliases.
    tombstones = "INSERT OR IGNORE INTO aliases(id,game,songIdentifier,aliasText,aliasNorm,source,status,createdAt,updatedAt) SELECT id,game,songIdentifier,aliasText,aliasNorm,'community','rejected',createdAt,updatedAt FROM community_alias_candidates WHERE status='rejected'"
    db.execute(tombstones)
    with sql_path.open('a') as output: output.write(tombstones+';\n')
    errors=db.execute('PRAGMA foreign_key_check').fetchall()
    if errors:raise SystemExit('Foreign key verification failed')
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    tombstone_count=db.execute("SELECT COUNT(*) FROM aliases WHERE status='rejected'").fetchone()[0]
    db.commit();db.close()
    digest=hashlib.sha256()
    with args.archive.open('rb') as file:
        for block in iter(lambda:file.read(1024*1024),b''):digest.update(block)
    report={'archiveSha256':digest.hexdigest(),'tables':counts,'foreignKeyCheck':'passed','integrityCheck':'passed','legacyRpId':env['WEBAUTHN_RP_ID'],'aliasTombstones':tombstone_count,'excluded':'profiles, scores, play records, tokens, challenges, bindings, imports, catalog, collections, games and jobs'}
    (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
