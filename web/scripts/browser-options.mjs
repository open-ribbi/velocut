/** Real GPU/WebGL tests on machines without a physical GPU. Linux uses
 * SwiftShader Vulkan and an Xvfb-backed headed browser for canvas presentation.
 * Windows keeps the native WARP backend; forcing ANGLE SwiftShader disables
 * WebGPU on Windows runners (see graphics-diagnostics.yml).
 * https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
 */
export const browserOptions = {
  headless: process.env.VELOCUT_HEADED !== '1',
  ...(process.platform !== 'darwin' ? { channel: 'chromium' } : {}),
  args: [
    '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ...(process.platform === 'linux' ? [
      '--use-gl=angle',
      '--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface',
    ] : process.platform === 'darwin' ? ['--use-gl=angle', '--use-angle=swiftshader'] : []),
  ],
};
