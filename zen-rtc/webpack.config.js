const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

const baseConfig = {
  mode: 'production',
  entry: './src/index.ts',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'index.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'ZenRTC',
    libraryTarget: 'umd',
    globalObject: 'this',
  },
};

const standardConfig = {
  ...baseConfig,
  optimization: {
    minimize: false,
  },
};

const minifiedConfig = {
  ...baseConfig,
  output: {
    ...baseConfig.output,
    filename: 'zen-rtc.min.js',
  },
  optimization: {
    minimize: true,
    minimizer: [new TerserPlugin()],
  },
};

module.exports = [standardConfig, minifiedConfig];