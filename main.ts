// Tiny stack VM for make.fun's tiny-stack-vm-01 (ISA v1).
// Runs every instance under the input dir and writes stdout.bin + exit.txt
// per instance under the output dir. Plain JavaScript in a .ts file so Node
// 22's type stripping runs it as-is. Deterministic: no clock, no random,
// no network, no environment input beyond the harness's input/output dirs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Opcode table: byte -> imm*100 + pops*10 + pushes, stored +1 (0 = invalid).
// Uint16Array: PUSH32's code (401, stored 402) does not fit in a byte.
const T = new Uint16Array(84);
for (const e of '00:0,01:101,02:401,03:10,04:12,05:22,06:23,07:33,10:21,11:21,12:21,13:21,14:21,15:21,16:21,17:11,18:21,19:21,1a:21,1b:11,1c:21,1d:21,1e:21,20:21,21:21,22:21,30:200,31:210,32:210,33:200,34:0,40:11,41:20,50:10,51:10,52:1,53:10'.split(',')) {
  const h = e.slice(0, 2), c = e.slice(3);
  T[parseInt(h, 16)] = +c + 1;
}

// Runs one program on its input bytes; returns [output bytes, exit code].
function run(p, inp) {
  const n = p.length;
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, st = 0;
  for (;;) {
    if (st === 1000000) return [out.subarray(0, ol), 10];
    if (pc < 0 || pc >= n) return [out.subarray(0, ol), 9];
    const op = p[pc];
    const t = T[op];
    if (!t) return [out.subarray(0, ol), 5];
    const c = t - 1, imm = (c / 100) | 0, pops = ((c / 10) | 0) % 10, push = c % 10;
    if (pc + imm >= n) return [out.subarray(0, ol), 9];
    st++;
    const nx = pc + 1 + imm;
    if (sp < pops) return [out.subarray(0, ol), 2];
    if (sp - pops + push > 256) return [out.subarray(0, ol), 3];
    pc = nx;
    switch (op) {
      case 0: return [out.subarray(0, ol), 0]; // HALT
      case 1: D[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 2: D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break; // PUSH32 LE
      case 3: sp--; break; // POP
      case 4: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 5: { const v = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = v; break; } // SWAP
      case 6: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 7: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG (wraps)
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = D[sp - 1], a = D[sp - 2];
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break; // ADD
          case 0x11: r = (a - b) | 0; break; // SUB
          case 0x12: r = Math.imul(a, b); break; // MUL, low 32 bits
          case 0x13: // DIV, truncated toward zero
            if (!b) return [out.subarray(0, ol), 4];
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0; break;
          case 0x14: // MOD, sign follows dividend
            if (!b) return [out.subarray(0, ol), 4];
            r = b === -1 ? 0 : (a % b) | 0; break;
          case 0x15: // DIVU
            if (!b) return [out.subarray(0, ol), 4];
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break;
          case 0x16: // MODU
            if (!b) return [out.subarray(0, ol), 4];
            r = ((a >>> 0) % (b >>> 0)) | 0; break;
          case 0x18: r = a & b; break; // AND
          case 0x19: r = a | b; break; // OR
          case 0x1a: r = a ^ b; break; // XOR
          case 0x1c: r = a << (b & 31); break; // SHL
          case 0x1d: r = a >> (b & 31); break; // SHR, arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
          case 0x20: r = a === b ? 1 : 0; break; // EQ
          case 0x21: r = a < b ? 1 : 0; break; // LT, signed
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU, unsigned
        }
        sp -= 2; D[sp++] = r; break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return [out.subarray(0, ol), 7];
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (!cp) return [out.subarray(0, ol), 8];
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return [out.subarray(0, ol), 6];
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE
        const a = D[sp - 1], v = D[sp - 2];
        if (a < 0 || a > 255) return [out.subarray(0, ol), 6];
        sp -= 2; M[a] = v;
        break;
      }
      case 0x50: { // PRINT, decimal ASCII
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return [out.subarray(0, ol), 11];
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC
        if (ol + 1 > 65536) return [out.subarray(0, ol), 11];
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: // IN
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      default: // EXIT (0x53)
        return [out.subarray(0, ol), D[--sp] & 255];
    }
  }
}

for (const id of readdirSync(I).sort()) {
  const [o, e] = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), o);
  writeFileSync(join(O, id, 'exit.txt'), e + '\n');
}
