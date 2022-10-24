import ResolveTypescriptPlugin from 'resolve-typescript-plugin'

const module = {
  rules: [
    {
      test: /\.ts$/,
      use: 'ts-loader',
      exclude: /node_modules/
    }
  ]
}
const resolve = {
  plugins: [new ResolveTypescriptPlugin()],
  extensions: ['.tsx', '.ts', '.js']
}

export default { module, resolve }
