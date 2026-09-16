# Independent Velocut Provider example

This package demonstrates an **illustrative**, non-production video protocol.
It imports only `@velocut/provider-sdk`, and compiles with ordinary TypeScript.
No Velocut checkout, React, renderer or editor imports are needed by its code.
The repository distribution test copies it to an independent consumer, compiles
it against installed tarballs and calls it with mocked fetch/credentials.

For a local unpublished build, install the provider-sdk tarball into the consumer
first. Build with `npm run build`. Replace the example URLs/protocol/validation
with the documented API of your chosen service before real use. Set your own
package name and publishing policy when turning it into a distributable plugin.

The host registers `exampleProvider` with `ProviderRegistry`, configures an
`example-video` channel and supplies a credential resolver. `submit` returns
remote identity and region. Preserve that entire receipt privately; `poll` uses
the original region, and `collect` exposes the output resource. This package
never chooses a timeline position, writes an asset or automatically retries a
paid request. See [the Provider guide](../../docs/integrations/providers.md).
