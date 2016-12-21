const fs = require('fs-promise')
const path = require('path')
const crypto = require('crypto')
const shell = require('shelljs')
const pm2 = require('pm2')
const Table = require('cli-table')
const username = require('username')
const resolveHome = require('./resolveHome')

const homeDir = resolveHome('~/.easy-pm')
const configsFile = path.resolve(homeDir, './configs')

const configsScriptPath = path.resolve(__dirname, './configs.js')
const setupScriptPath = path.resolve(__dirname, './setup.js')

module.exports = { start, list }

function start(relConfigPath) {
	const isRoot = process.getuid() === 0

	const configPath = path.resolve(process.cwd(), resolveHome(relConfigPath))
	let configPaths = []

	username()
		.then(name => {
			const rootPrefix = isRoot ? `sudo -u ${name}` : ''
			shell.exec(`${rootPrefix} node ${configsScriptPath} add ${configPath}`)
			shell.exec(`${rootPrefix} node ${setupScriptPath}`)
			console.log('\nStarting easy-pm-server...')
		})
		.then(() => fs.readFile(configsFile, 'utf8'))
		.then(configsStr => {
			configPaths = configsStr.split('\n').filter(s => !/^\s*$/.test(s))
			return Promise.all(configPaths.map(configPath => {
				return fs.readFile(configPath, 'utf8')
					.then(configStr => {
						const config = JSON.parse(configStr)
						const root = path.resolve(configPath, resolveHome(config.root))
						const apps = config.apps.map(app => {
							const branch = app.branch || 'master'
							const configPathHash = crypto.createHash('sha1').update(configPath).digest('hex')
							app.env = Object.assign({
								epm_config_path: configPath,
								epm_server_port: config.port || 80
							}, app.env)
							return Object.assign({
								cwd: path.resolve(root, app.path || app.name),
								script: 'npm',
								args: 'start',
								watch: true
							}, app, {
								name: `${app.name}-${branch}-${configPathHash}`
							})
						})

						return apps
					})
			}))
		})
		.then(appGroups => {
			const apps = appGroups.reduce((prev, appList) => prev.concat(appList), [])
			apps.push({
				name: 'easy-pm-server',
				script: './server.js',
				watch: [configsFile].concat(configPaths),
				env: {
					epm_start: true
				}
			})

			return new Promise((resolve, reject) => {
				pm2.connect(err => {
					if (err) {
						console.log(err)
						process.exit(2)
					}

					pm2.start({ apps }, err => {
						pm2.disconnect()
						if (err) reject(err)
						else resolve()
					})
				})
			})
		})
		.then(() => {
			console.log('easy-pm-server started\n')
			listByConfigs(configPaths)
		})
}

function list() {
	return fs.readFile(configsFile, 'utf8')
		.then(configsStr => configsStr.split('\n').filter(s => !/^\s*$/.test(s)))
		.then(configPaths => listByConfigs(configPaths))
}

function listByConfigs(configPaths) {
	const configs = {}
	configPaths.forEach(configPath => {
		configs[configPath] = {
			table: new Table({
				head: ['Name', 'branch', 'pid', 'status', 'restart', 'cpu', 'memory'],
				style: {
					head: ['cyan', 'bold']
				}
			})
		}
	})
	return new Promise((resolve, reject) => {
		pm2.connect(err => {
			if (err) {
				console.log(err)
				process.exit(2)
			}

			pm2.list((err, apps) => {
				pm2.disconnect()
				if (err) return reject(err)

				apps.forEach((app) => {
					const configPath = app.pm2_env.epm_config_path
					const pmName = app.name.split('-')
					pmName.pop()
					const branch = pmName.pop()
					const name = pmName.join('-')
					const pid = app.pid
					const status = app.pm2_env.status
					const restart = app.pm2_env.restart_time
					const cpu = app.monit.cpu + '%'
					let memory = app.monit.memory / 1024
					if (memory < 1024) {
						memory = memory.toFixed(1) + ' KB'
					} else if (memory < 1024 * 1024) {
						memory = (memory / 1024).toFixed(1) + ' MB'
					} else {
						memory = (memory / 1024 / 1024).toFixed(1) + ' GB'
					}

					if (configs[configPath]) {
						const rootRe = new RegExp(`/${name}$`)
						configs[configPath].port = configs.port || app.pm2_env.epm_server_port || 80
						configs[configPath].root = app.pm2_env.cwd.replace(rootRe, '') || ''
						configs[configPath].table.push({
							[name]: [branch, pid, status, restart, cpu, memory]
						})
					}
				})
				resolve()
			})
		})
	})
		.then(() => {
			configPaths.forEach(configPath => {
				const config = configs[configPath]
				const table = config.table
				console.log(`Config File: ${configPath}`)
				console.log(`App Directory: ${config.root}`)
				console.log(`Listening on port ${config.port || 80}: ${table.length} ${table.length > 1 ? 'apps' : 'app'} running`)
				console.log(table.toString())
				console.log('')
			})
		})
}