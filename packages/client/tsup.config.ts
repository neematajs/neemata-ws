import { esbuildPluginFilePathExtensions } from 'esbuild-plugin-file-path-extensions'
import { defineConfig } from 'tsup'

export default defineConfig({
  outDir: 'dist',
  entry: ['index.ts'],
  sourcemap: true,
  bundle: true,
  clean: true,
  format: 'esm',
  target: 'esnext',
  platform: 'neutral',
  esbuildPlugins: [
    esbuildPluginFilePathExtensions({
      esmExtension: 'js',
      cjsExtension: 'cjs',
      esm: ({ format }) => format === 'esm',
    }),
  ],
})
