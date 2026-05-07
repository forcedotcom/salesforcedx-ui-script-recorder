#!/usr/bin/env node

import { program } from 'commander'
import { startRecording } from '../src/index.js'
import { convertToPlaywright } from '../src/playwright-converter.js'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'

program
  .name('salesforce-ui-recorder')
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
  .option('--cloud <cloud>', 'Cloud identifier for Playwright conversion', '')
  .option('--user <user>', 'Username for Playwright conversion', '')
  .option('--team <team>', 'Team name for Playwright conversion', '')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🎬 Salesforce UI Recorder\n'))
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

program
  .command('convert')
  .description('Convert a recorded JSON file to a Playwright script')
  .argument('<input>', 'Path to the recording JSON file')
  .option('-o, --output <path>', 'Output path for the Playwright script')
  .option('--cloud <cloud>', 'Cloud identifier', '')
  .option('--user <user>', 'Username', '')
  .option('--team <team>', 'Team name', '')
  .action(async (input, options) => {
    console.log(chalk.blue.bold('\n🎬 Salesforce UI Recorder — Convert\n'))

    const inputPath = path.resolve(input)
    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`  Error: File not found: ${inputPath}`))
      process.exit(1)
    }

    const outputPath = options.output
      ? path.resolve(options.output)
      : inputPath.replace(/\.json$/, '.spec.js')

    try {
      const userFlow = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))
      console.log(chalk.gray(`  Input:  ${inputPath}`))
      console.log(chalk.gray(`  Output: ${outputPath}\n`))
      console.log(chalk.gray('  Converting to Playwright script...'))

      const playwrightCode = await convertToPlaywright(userFlow, {
        cloud: options.cloud,
        user: options.user,
        team: options.team
      })

      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, playwrightCode)
      console.log(chalk.green(`  ✓ Playwright script saved to: ${outputPath}\n`))
    } catch (err) {
      console.error(chalk.red(`  Error: ${err.message}\n`))
      process.exit(1)
    }
  })

program.parse()
