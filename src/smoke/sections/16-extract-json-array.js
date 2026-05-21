export default async function ({ ok }) {
  console.log('\n[16] extractJsonArray (tag batch parser)');

  const { extractJsonArray } = await import('../../indexer/phases/tag.js');

  ok('flat array → returned as-is',
    JSON.stringify(extractJsonArray('[["a","b"],["c","d"]]', 2)) === '[["a","b"],["c","d"]]');

  ok('object wrapper {"tags":[[...]],"tags2":[[...]]} → flattened',
    JSON.stringify(extractJsonArray('{"tags":[["a","b"]],"tags2":[["c","d"]]}', 2)) === '[["a","b"],["c","d"]]');

  ok('flat strings per chunk {"c0":["a"],"c1":["b"]} → flattened',
    JSON.stringify(extractJsonArray('{"c0":["a","b"],"c1":["c","d"]}', 2)) === '[["a","b"],["c","d"]]');

  ok('wrong length → null',
    extractJsonArray('[["a"],["b"],["c"]]', 2) === null);

  ok('empty object → null',
    extractJsonArray('{}', 2) === null);

  ok('markdown fenced → parsed',
    JSON.stringify(extractJsonArray('```json\n[["a"],["b"]]\n```', 2)) === '[["a"],["b"]]');

  ok('16g: numbered-key object with empty tag group → [[], ["a","b"]]',
    JSON.stringify(extractJsonArray('{"tags_0":[],"tags_1":["a","b"]}', 2)) === '[[],["a","b"]]');

  ok('16h: three numbered keys, middle empty → [["a"], [], ["c"]]',
    JSON.stringify(extractJsonArray('{"tags0":["a"],"tags1":[],"tags2":["c"]}', 3)) === '[["a"],[],["c"]]');

  ok('16i: object array containing objects → null (not accepted)',
    extractJsonArray('{"tags0":[{"bad":true}],"tags1":["a"]}', 2) === null);

  ok('16j: object array containing numbers → null (not accepted)',
    extractJsonArray('{"tags0":[1,2],"tags1":["a"]}', 2) === null);
}
