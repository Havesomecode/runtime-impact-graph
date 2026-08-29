import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const readProjectFile = async (relativePath: string): Promise<string> =>
  readFile(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
  );

const unscopedPackageSpecifier =
  /(?<![@\w/-])runtime-impact-graph(?:\/(?:json|dot))?(?=[`'"])/u;

describe('public package documentation', () => {
  it('describes the scoped 0.1.0 release candidate without claiming publication', async () => {
    const readme = await readProjectFile('README.md');

    assert.match(
      readme,
      /public package is scoped as `@havesomecode\/runtime-impact-graph` at version `0\.1\.0`/u,
    );
    assert.match(readme, /not yet available from a registry/u);
    assert.doesNotMatch(
      readme,
      /0\.0\.0-development|private development identifiers/u,
    );
  });

  it('uses only scoped package specifiers in the README and API guide', async () => {
    const documents = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('docs/api-v0.1.md'),
    ]);

    for (const document of documents) {
      assert.doesNotMatch(document, unscopedPackageSpecifier);
      assert.match(document, /@havesomecode\/runtime-impact-graph/u);
    }
  });

  it('documents both scoped formatter subpaths', async () => {
    const documents = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('docs/api-v0.1.md'),
    ]);

    for (const document of documents) {
      assert.match(document, /@havesomecode\/runtime-impact-graph\/json/u);
      assert.match(document, /@havesomecode\/runtime-impact-graph\/dot/u);
    }
  });
});
