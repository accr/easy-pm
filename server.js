const crypto = require('crypto')
const http = require('http')
const path = require('path')
const shell = require('shelljs')
const pm2 = require('pm2')
const proxy = require('http-proxy').createProxyServer({})
const username = require('username')

const config = require('./config')
config.root = config.root || ''
const port = process.env.PORT || config.port || 80

const routes = {}
config.apps.forEach(app => {
	if (app.domains) {
		app.domains.forEach(domain => {
			routes[domain] = app.port
		})
	}
})

username().then(name => {
	const isRoot = process.getuid() === 0
	const rootPrefix = isRoot ? `sudo -u ${name}` : ''

	http.createServer((req, res) => {
		const host = req.headers.host.split(':')[0]
		if (routes[host]) {
			proxy.web(req, res, {
				target: `http://127.0.0.1:${routes[host]}`
			})
		} else {
			console.log(req.headers)
			const chunks = []
			const hookedApp = config.apps.find(app => {
				const re = new RegExp(`^/hooks/${app.name}/?([\?|#].*)?$`)
				return re.test(req.url)
			})
			if (hookedApp) {
				const branch = hookedApp.branch || 'master'
				const appPath = path.resolve(config.root, hookedApp.path || hookedApp.name)
				req.on('data', chunk => chunks.push(chunk))
					.on('end', () => {
						const body = Buffer.concat(chunks).toString()
						const ghSignature = req.headers['x-hub-signature'].replace(/^sha1=/, '')
						const signature = crypto.createHmac('sha1', config.webhook.token).update(body).digest('hex')
						if (signature === ghSignature) {
							shell.exec(`cd ${appPath} && ${rootPrefix} git pull && ${rootPrefix} git checkout ${branch} && ${rootPrefix} npm install`)
						}
					})
			}
			res.end()
		}
	}).listen(port)
})