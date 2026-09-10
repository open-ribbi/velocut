/** Real GPU/WebGL tests on machines without a physical GPU. Linux uses
 * SwiftShader Vulkan and an Xvfb-backed headed browser for canvas presentation.
 * https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
 */
export const browserOptions = {
  headless: process.env.VELOCUT_HEADED !== '1',
  ...(process.platform === 'linux' ? { channel: 'chromium' } : {}),
  args: [
    '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--use-gl=angle',
    ...(process.platform === 'linux' ? [
      '--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface',
    ] : ['--use-angle=swiftshader']),
  ],
};
