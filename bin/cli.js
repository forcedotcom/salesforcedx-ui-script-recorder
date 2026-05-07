#!/usr/bin/env node

import { program } from 'commander'
import { startRecording } from '../src/index.js'
import chalk from 'chalk'

program
  .name('fresh-ui-recorder')
  .description('Record browser interactions via a CLI with an in-page overlay')
  .version('1.0.0')

program
  .command('record')
  .description('Launch a browser and start recording user interactions')
  .option('-u, --url <url>', 'Starting URL to navigate to', 'about:blank')
  .option('-o, --output <path>', 'Output file path for the recording JSON', './recording.json')
  .option('--headed', 'Run in headed mode (default)', true)
  .option('--headless', 'Run in headless mode', false)
  .option('--browser <browser>', 'Browser to use (chromium, firefox, webkit)', 'chromium')
  .option('--data-attribute <attr>', 'Custom data attribute for selectors', '')
  .option('--viewport-width <width>', 'Viewport width', '1280')
  .option('--viewport-height <height>', 'Viewport height', '720')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🎬 Fresh UI Recorder\n'))
    console.log(chalk.gray(`  URL: ${options.url}`))
    console.log(chalk.gray(`  Output: ${options.output}`))
    console.log(chalk.gray(`  Browser: ${options.browser}\n`))

    try {
      await startRecording(options)
    } catch (err) {
      console.error(chalk.red(`\nError: ${err.message}`))
      process.exit(1)
    }
  })

program.parse()
