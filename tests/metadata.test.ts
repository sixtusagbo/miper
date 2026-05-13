import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { decodeMetadata, fetchTokenMetadata, metadataPda } from '../src/metadata';

// Builds a Metaplex metadata account buffer using the same layout the
// program writes: 1-byte key + 32-byte updateAuthority + 32-byte mint,
// then each string as u32 LE length prefix + the puffed (null-padded)
// string bytes. Good enough to round-trip through decodeMetadata.
function buildMetadataAccount(name: string, symbol: string, uri: string): Buffer {
  const MAX_NAME = 32;
  const MAX_SYMBOL = 10;
  const MAX_URI = 200;

  function puffed(s: string, max: number): Buffer {
    const out = Buffer.alloc(max, 0);
    Buffer.from(s, 'utf8').copy(out, 0);
    return out;
  }

  const header = Buffer.alloc(1 + 32 + 32, 0);
  header[0] = 4; // key
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32LE(MAX_NAME, 0);
  const symLen = Buffer.alloc(4);
  symLen.writeUInt32LE(MAX_SYMBOL, 0);
  const uriLen = Buffer.alloc(4);
  uriLen.writeUInt32LE(MAX_URI, 0);
  return Buffer.concat([
    header,
    nameLen,
    puffed(name, MAX_NAME),
    symLen,
    puffed(symbol, MAX_SYMBOL),
    uriLen,
    puffed(uri, MAX_URI),
    // Tail bytes (sellerFeeBasisPoints, creators, flags) — we don't decode them.
    Buffer.alloc(32, 0),
  ]);
}

describe('metadataPda', () => {
  it('derives a deterministic PDA for a given mint', () => {
    const mint = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    const pda1 = metadataPda(mint);
    const pda2 = metadataPda(mint);
    expect(pda1.toBase58()).toBe(pda2.toBase58());
    expect(pda1.toBase58()).not.toBe(mint.toBase58());
  });
});

describe('decodeMetadata', () => {
  it('decodes name, symbol, and uri from a well-formed buffer', () => {
    const buf = buildMetadataAccount('Pepe Coin', 'PEPE', 'https://ipfs.io/ipfs/Qm.../metadata.json');
    const md = decodeMetadata(buf);
    expect(md.name).toBe('Pepe Coin');
    expect(md.symbol).toBe('PEPE');
    expect(md.uri).toBe('https://ipfs.io/ipfs/Qm.../metadata.json');
  });

  it('strips the null-byte padding from puffed strings', () => {
    const buf = buildMetadataAccount('X', 'Y', 'Z');
    const md = decodeMetadata(buf);
    expect(md.name).toBe('X');
    expect(md.symbol).toBe('Y');
    expect(md.uri).toBe('Z');
  });

  it('throws on truncated buffers', () => {
    const buf = Buffer.alloc(40); // way too short
    expect(() => decodeMetadata(buf)).toThrow(/truncated/);
  });
});

describe('fetchTokenMetadata', () => {
  function fakeConnection(info: { data: Buffer } | null) {
    return {
      getAccountInfo: vi.fn().mockResolvedValue(info),
    } as any;
  }

  it('returns null when the metadata account does not exist', async () => {
    const md = await fetchTokenMetadata(
      fakeConnection(null),
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    );
    expect(md).toBeNull();
  });

  it('returns decoded metadata when the account is present', async () => {
    const buf = buildMetadataAccount('Doge', 'DOGE', 'https://example.com/d.json');
    const md = await fetchTokenMetadata(
      fakeConnection({ data: buf }),
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    );
    expect(md).toEqual({
      name: 'Doge',
      symbol: 'DOGE',
      uri: 'https://example.com/d.json',
    });
  });

  it('returns null when the RPC call throws', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as any;
    const md = await fetchTokenMetadata(
      conn,
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    );
    expect(md).toBeNull();
  });

  it('returns null when the buffer is malformed', async () => {
    const md = await fetchTokenMetadata(
      fakeConnection({ data: Buffer.alloc(10) }),
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    );
    expect(md).toBeNull();
  });
});
