import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptFieldWithKey, encryptFieldWithKey, fieldDigestWithKey, fieldKeyId, parseFieldKey } from '../src/security.mjs';

const oldKey=Buffer.alloc(32,3),newKey=Buffer.alloc(32,9);
function legacy(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',oldKey,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${body.toString('base64url')}`;}

test('criptografia versionada lê legado e identifica a chave sem expô-la',()=>{
  assert.equal(decryptFieldWithKey(legacy('cliente'),oldKey),'cliente');
  const encrypted=encryptFieldWithKey('cliente',newKey);
  assert.match(encrypted,new RegExp(`^v2:${fieldKeyId(newKey)}:`));
  assert.equal(decryptFieldWithKey(encrypted,newKey),'cliente');
  assert.throws(()=>decryptFieldWithKey(encrypted,oldKey));
});

test('rotação muda ciphertext e hashes de busca preservando o valor',()=>{
  const before=legacy('11999999999'),plain=decryptFieldWithKey(before,oldKey),after=encryptFieldWithKey(plain,newKey);
  assert.notEqual(before,after);
  assert.equal(decryptFieldWithKey(after,newKey),plain);
  assert.notEqual(fieldDigestWithKey(plain,oldKey),fieldDigestWithKey(plain,newKey));
  assert.equal(parseFieldKey(newKey.toString('base64')).equals(newKey),true);
});
