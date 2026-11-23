/** Binary Apple property lists used inside Notability note archives. */
export function readBinaryPlist(bytes: Uint8Array): any {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  if (decoder.decode(bytes.subarray(0, 8)) !== "bplist00" || bytes.length < 40) throw new Error("Unsupported Notability property list.");
  const unsigned = (offset: number, size: number): number => {
    let value = 0;
    for (let index = 0; index < size; index++) value = value * 256 + view.getUint8(offset + index);
    if (!Number.isSafeInteger(value)) throw new Error("Property list integer exceeds supported size.");
    return value;
  };
  const trailer = bytes.length - 32;
  const offsetSize = view.getUint8(trailer + 6), referenceSize = view.getUint8(trailer + 7);
  const count = unsigned(trailer + 8, 8), root = unsigned(trailer + 16, 8), table = unsigned(trailer + 24, 8);
  if (!offsetSize || offsetSize > 8 || !referenceSize || referenceSize > 8 || count > 1000000 || table + count * offsetSize > trailer) throw new Error("Invalid property list object table.");
  const cache = new Map<number, any>();
  const read = (id: number, depth = 0): any => {
    if (cache.has(id)) return cache.get(id);
    if (id >= count || depth > 128) throw new Error("Invalid property list object reference.");
    let offset = unsigned(table + id * offsetSize, offsetSize);
    const marker = view.getUint8(offset++), type = marker >> 4;
    let length = marker & 15;
    if ([4, 5, 6, 7, 10, 12, 13].includes(type) && length === 15) {
      const integer = view.getUint8(offset++);
      if (integer >> 4 !== 1) throw new Error("Invalid property list length.");
      const size = 2 ** (integer & 15);
      length = unsigned(offset, size); offset += size;
    }
    let result: any;
    if (type === 0) result = marker === 9 ? true : marker === 8 ? false : null;
    else if (type === 1) result = length === 3 ? Number(view.getBigInt64(offset)) : unsigned(offset, 2 ** length);
    else if (type === 2) result = length === 2 ? view.getFloat32(offset) : view.getFloat64(offset);
    else if (type === 3) result = new Date((view.getFloat64(offset) + 978307200) * 1000);
    else if (type === 4) result = bytes.slice(offset, offset + length);
    else if (type === 5 || type === 7) result = decoder.decode(bytes.subarray(offset, offset + length));
    else if (type === 6) result = new TextDecoder("utf-16be").decode(bytes.subarray(offset, offset + length * 2));
    else if (type === 8) result = { uid: unsigned(offset, length + 1) };
    else if (type === 10 || type === 12) {
      result = []; cache.set(id, result);
      for (let index = 0; index < length; index++) result.push(read(unsigned(offset + index * referenceSize, referenceSize), depth + 1));
    } else if (type === 13) {
      result = Object.create(null); cache.set(id, result);
      for (let index = 0; index < length; index++) {
        const key = read(unsigned(offset + index * referenceSize, referenceSize), depth + 1);
        result[key] = read(unsigned(offset + (index + length) * referenceSize, referenceSize), depth + 1);
      }
    } else throw new Error(`Unsupported property list type ${type}.`);
    cache.set(id, result);
    return result;
  };
  return read(root);
}

export function unarchivePlist(archive: any): any {
  if (!Array.isArray(archive.$objects) || !archive.$top) throw new Error("Invalid Notability session archive.");
  const cache = new Map<number, any>();
  const resolve = (value: any, depth = 0): any => {
    if (depth > 128) throw new Error("Notability session nesting exceeds supported depth.");
    if (value && typeof value === "object" && "uid" in value) {
      if (value.uid === 0) return null;
      if (cache.has(value.uid)) return cache.get(value.uid);
      const object = archive.$objects[value.uid];
      if (object === undefined) throw new Error("Invalid session object reference.");
      const result = resolve(object, depth + 1);
      cache.set(value.uid, result);
      return result;
    }
    if (value instanceof Uint8Array || value instanceof Date || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => resolve(entry, depth + 1));
    if (value["NS.keys"]) {
      const keys = resolve(value["NS.keys"], depth + 1), entries = resolve(value["NS.objects"], depth + 1);
      return Object.fromEntries(keys.map((key: string, index: number) => [key, entries[index]]));
    }
    if (value["NS.objects"]) return resolve(value["NS.objects"], depth + 1);
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$class").map(([key, entry]) => [key, resolve(entry, depth + 1)]));
  };
  return resolve(archive.$top.root ?? archive.$top.$0);
}
