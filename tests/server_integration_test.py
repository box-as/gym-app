#!/usr/bin/env python3
"""RepState server integration test; no third-party packages or live accounts.
Run: python3 tests/server_integration_test.py
"""
import http.client, json, os, pathlib, shutil, subprocess, tempfile, time, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
class Client:
    def __init__(self, port): self.port=port; self.cookie=''
    def request(self, method, path, body=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        headers={'Content-Type':'application/json','Origin':f'http://127.0.0.1:{self.port}'}
        if self.cookie: headers['Cookie']=self.cookie
        c.request(method,path, json.dumps(body).encode() if body is not None else None, headers)
        r=c.getresponse(); raw=r.read(); set_cookie=r.getheader('Set-Cookie')
        if set_cookie: self.cookie=set_cookie.split(';',1)[0]
        status=r.status; c.close()
        return status, json.loads(raw or b'{}')

class ServerIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.mkdtemp(prefix='repstate-test-'); cls.port=18765
        env={**os.environ,'DATA_DIR':cls.tmp,'PORT':str(cls.port),'COOKIE_SECURE':'0','PYTHONUNBUFFERED':'1'}
        cls.proc=subprocess.Popen(['python3','server.py'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True)
        for _ in range(50):
            try:
                if Client(cls.port).request('GET','/api/healthz')[0]==200: break
            except OSError: time.sleep(.1)
        else: raise RuntimeError('server did not start')
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate(); cls.proc.wait(timeout=5); shutil.rmtree(cls.tmp,ignore_errors=True)
    def register(self, username):
        c=Client(self.port); s,b=c.request('POST','/api/register',{'username':username,'password':'correct horse battery staple'}); self.assertEqual(s,201,b); return c
    def test_two_accounts_private_state_and_extras(self):
        a=self.register('alice-test'); b=self.register('bob-test')
        state={'settings':{'phase':'Bulk','startDate':'2024-01-01','activeWeek':5},'logs':{'1:extra':{'sets':[{'reps':12,'load':80,'extraSet':True}]}},'sessionDates':{'1|Tuesday — Lower A':'2025-01-07'},'checkins':{},'milestones':{},'syncMeta':{}}
        s,x=a.request('PUT','/api/state',{'state':state,'revision':0}); self.assertEqual(s,200,x); self.assertEqual(x['revision'],1)
        self.assertEqual(b.request('GET','/api/state')[1],{'state':None,'revision':0,'updatedAt':None})
        s,x=a.request('GET','/api/state'); self.assertEqual(s,200); self.assertEqual(x['state'],state); self.assertEqual(x['state']['settings']['activeWeek'],5); self.assertEqual(x['state']['logs']['1:extra']['sets'][0]['extraSet'],True)
        s,x=b.request('PUT','/api/state',{'state':{'logs':{'bob':{'sets':[{'reps':8}]}}},'revision':0}); self.assertEqual(s,200)
        self.assertNotEqual(a.request('GET','/api/state')[1]['state'], b.request('GET','/api/state')[1]['state'])
        self.assertNotIn('activeWeek',b.request('GET','/api/state')[1]['state'].get('settings',{}),'another account must not inherit the active week')
    def test_revision_conflict_and_account_survives_restart(self):
        a=self.register('revision-test'); payload={'logs':{'x':{'sets':[{'reps':10}]}},'sessionDates':{'1|Friday — Lower B':'2025-01-10'}}
        self.assertEqual(a.request('PUT','/api/state',{'state':payload,'revision':0})[0],200)
        s,conf=a.request('PUT','/api/state',{'state':{'logs':{'stale':1}},'revision':0}); self.assertEqual(s,409); self.assertEqual(conf['revision'],1); self.assertEqual(conf['state'],payload)
        # Stop and start against exactly the same temporary DATA_DIR.
        self.__class__.proc.terminate(); self.__class__.proc.wait(timeout=5)
        env={**os.environ,'DATA_DIR':self.tmp,'PORT':str(self.port),'COOKIE_SECURE':'0','PYTHONUNBUFFERED':'1'}
        self.__class__.proc=subprocess.Popen(['python3','server.py'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True)
        for _ in range(50):
            try:
                if Client(self.port).request('GET','/api/healthz')[0]==200: break
            except OSError: time.sleep(.1)
        s,x=a.request('GET','/api/state'); self.assertEqual(s,200); self.assertEqual(x['state'],payload)
    def test_production_database_not_used(self):
        self.assertTrue((pathlib.Path(self.tmp)/'repstate.sqlite3').exists())
        # DATA_DIR is isolated, so this test never opens the default /data DB.
        self.assertFalse((ROOT/'repstate.sqlite3').exists())

if __name__=='__main__':
    unittest.main(verbosity=2)
