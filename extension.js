const vscode = require('vscode');
const https = require('https');
let spotifyPanel = null;
let updateInterval = null;
let accessToken = null;
let tokenExpiresAt = null;
let lastTrackId = null;


function getClientId() {
    const config = vscode.workspace.getConfiguration('spotifyWidget');
    if(config.get('clientId')) {
        return config.get('clientId');
    } else {
        return 'ac8d0a8761004cfbb0b582950be8314c';
    }
}

const REDIRECT_URI = 'https://itsnotalexy.github.io/vscode-spotify-widget-auth/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

let pendingCodeVerifier = null;

function activate(context) {
    console.log('Spotify Widget extension is now active');
    accessToken = context.globalState.get('spotifyAccessToken');
    tokenExpiresAt = context.globalState.get('spotifyTokenExpiresAt');

    let authCommand = vscode.commands.registerCommand('spotify-widget.authenticate', async function () {
        await authenticateSpotify(context);
    });

    let handleUriCommand = vscode.commands.registerCommand('spotify-widget.handleUri', async function (uri) {
        await handleAuthCallback(uri, context);
    });
    
    let showCommand = vscode.commands.registerCommand('spotify-widget.show', function () {
        createOrShowSpotifyWidget(context);
    });
    let hideCommand = vscode.commands.registerCommand('spotify-widget.hide', function () {
        if (spotifyPanel) {
            spotifyPanel.dispose();
        }
    });

    context.subscriptions.push(authCommand);
    context.subscriptions.push(handleUriCommand);
    context.subscriptions.push(showCommand);
    context.subscriptions.push(hideCommand);

    const uriHandler = {
        handleUri: async (uri) => {
            if (uri.path === '/auth') {
                await handleAuthCallback(uri, context);
            }
        }
    };
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    setTimeout(() => {
        createOrShowSpotifyWidget(context);
    }, 1000);
}

async function handleAuthCallback(uri, context) {
    try {
        const query = new URLSearchParams(uri.query);
        const code = query.get('code');
        
        if (!code) {
            vscode.window.showErrorMessage('No authorization code found in callback');
            return;
        }

        const codeVerifier = pendingCodeVerifier || context.globalState.get('pendingCodeVerifier');
        if (!codeVerifier) {
            vscode.window.showErrorMessage('Authentication session expired. Please try again.');
            return;
        }
        
        const clientId = getClientId();
        await completeAuthentication(code, codeVerifier, clientId, context);
        
        pendingCodeVerifier = null;
        await context.globalState.update('pendingCodeVerifier', undefined);
        
    } catch (error) {
        vscode.window.showErrorMessage('Failed to handle authentication callback: ' + error.message);
    }
}

async function completeAuthentication(code, codeVerifier, clientId, context) {
    try {
        const tokens = await exchangeCodeForToken(code, codeVerifier, clientId);
        
        accessToken = tokens.access_token;
        tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);

        await context.globalState.update('spotifyAccessToken', accessToken);
        await context.globalState.update('spotifyTokenExpiresAt', tokenExpiresAt);

        vscode.window.showInformationMessage('Successfully authenticated with Spotify!');
    } catch (error) {
        vscode.window.showErrorMessage('Authentication failed: ' + error.message);
        throw error;
    }
}

async function authenticateSpotify(context) {
    const clientId = getClientId();
    const codeVerifier = generateRandomString(128);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    pendingCodeVerifier = codeVerifier;
    await context.globalState.update('pendingCodeVerifier', codeVerifier);
    
    const authUrl = `https://accounts.spotify.com/authorize?` +
        `client_id=${clientId}&` +
        `response_type=code&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `scope=${encodeURIComponent(SCOPES)}&` +
        `code_challenge_method=S256&` +
        `code_challenge=${codeChallenge}&` +
        `show_dialog=true`;

    const result = await vscode.window.showInformationMessage(
        'You will be redirected to Spotify to authenticate. After authorizing, you can either click "Open in VS Code" on the page or paste the code manually.',
        'Open Spotify Login', 'Cancel'
    );

    if (result === 'Open Spotify Login') {
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const manualInput = await vscode.window.showInputBox({
            prompt: 'If auto-login didn\'t work, paste the authorization code from the page (or press Esc if already authenticated)',
            placeHolder: 'AQD... (optional if you used "Open in VS Code" button)',
            ignoreFocusOut: true,
            password: false
        });

        if (manualInput) {
            await completeAuthentication(manualInput.trim(), codeVerifier, clientId, context);
        }
    }
}

async function handleAuthCallback(uri, context) {
    try {
        const query = new URLSearchParams(uri.query);
        const code = query.get('code');
        
        if (!code) {
            vscode.window.showErrorMessage('No authorization code found in callback');
            return;
        }
        
        const codeVerifier = pendingCodeVerifier || context.globalState.get('pendingCodeVerifier');
        
        if (!codeVerifier) {
            vscode.window.showErrorMessage('Authentication session expired. Please try again.');
            return;
        }
        
        const clientId = getClientId();
        await completeAuthentication(code, codeVerifier, clientId, context);

        pendingCodeVerifier = null;
        await context.globalState.update('pendingCodeVerifier', undefined);
        
    } catch (error) {
        vscode.window.showErrorMessage('Failed to handle authentication callback: ' + error.message);
    }
}

async function completeAuthentication(code, codeVerifier, clientId, context) {
    try {
        const tokens = await exchangeCodeForToken(code, codeVerifier, clientId);
        
        accessToken = tokens.access_token;
        tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);

        await context.globalState.update('spotifyAccessToken', accessToken);
        await context.globalState.update('spotifyTokenExpiresAt', tokenExpiresAt);

        vscode.window.showInformationMessage('Successfully authenticated with Spotify!');
    } catch (error) {
        vscode.window.showErrorMessage('Authentication failed: ' + error.message);
        throw error;
    }
}

function generateRandomString(length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return values.reduce((acc, x) => acc + possible[x % possible.length], '');
}

async function generateCodeChallenge(codeVerifier) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(codeVerifier).digest();
    return base64URLEncode(hash);
}

function base64URLEncode(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function exchangeCodeForToken(code, codeVerifier, clientId) {
    return new Promise((resolve, reject) => {
        const postData = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            code_verifier: codeVerifier
        }).toString();

        const options = {
            hostname: 'accounts.spotify.com',
            path: '/api/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Token exchange failed: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function createOrShowSpotifyWidget(context) {
    if (spotifyPanel) {
        spotifyPanel.reveal(vscode.ViewColumn.Two);
        return;
    }

    spotifyPanel = vscode.window.createWebviewPanel(
        'spotifyWidget',
        'Spotify Player',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: []
        }
    );

    spotifyPanel.webview.html = getWebviewContent();

    spotifyPanel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'playPause':
                    await sendSpotifyCommand('PlayPause');
                    break;
                case 'next':
                    await sendSpotifyCommand('Next');
                    break;
                case 'previous':
                    await sendSpotifyCommand('Previous');
                    break;
                case 'getCurrentTrack':
                    const trackInfo = await getCurrentTrack();
                    spotifyPanel.webview.postMessage({
                        command: 'updateTrack',
                        data: trackInfo
                    });
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
    const config = vscode.workspace.getConfiguration('spotifyWidget');
    const refreshInterval = config.get('refreshInterval', 1000); 

    updateInterval = setInterval(async () => {
        if (spotifyPanel) {
            const trackInfo = await getCurrentTrack();
            spotifyPanel.webview.postMessage({
                command: 'updateTrack',
                data: trackInfo
            });
        }
    }, refreshInterval);
    spotifyPanel.onDidDispose(
        () => {
            spotifyPanel = null;
            if (updateInterval) {
                clearInterval(updateInterval);
                updateInterval = null;
            }
        },
        null,
        context.subscriptions
    );
}

async function getCurrentTrack() {
    if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
        return createEmptyTrackInfo('Token expired', 'Please re-authenticate with Spotify');
    }
    if (!accessToken) {
        return createEmptyTrackInfo('Not authenticated', 'Run "Authenticate with Spotify" command');
    }
    try {
        const data = await spotifyApiRequest('/v1/me/player/currently-playing');

        if (!data || !data.item) {
            return createEmptyTrackInfo('No track playing', 'Start playing music on Spotify');
        }
        const currentTrackId = data.item.id;
        if (lastTrackId !== currentTrackId) {
            lastTrackId = currentTrackId;
        }

        return {
            isPlaying: data.is_playing,
            track: data.item.name,
            artist: data.item.artists.map(a => a.name).join(', '),
            album: data.item.album.name,
            albumArt: data.item.album.images[0]?.url || '',
            progress: data.progress_ms || 0,
            duration: data.item.duration_ms || 0
        };
    } catch (error) {
		vscode.window.showErrorMessage('Spotify API error: ' + error.message);
        
        if (error.message.includes('401')) {
            return createEmptyTrackInfo('Authentication expired', 'Please re-authenticate');
        }
        return createEmptyTrackInfo('Connecting...', 'Loading track info');
    }
}

function spotifyApiRequest(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.spotify.com',
            path: path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 204) {
                resolve(null);
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error('Failed to parse response'));
                    }
                } else {
                    reject(new Error(`${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

function createEmptyTrackInfo(artist, album) {
    return {
        isPlaying: false,
        track: null,
        artist: artist,
        album: album,
        albumArt: '',
        progress: 0,
        duration: 0,
        error: true
    };
}

async function sendSpotifyCommand(command) {
    try {
        const { exec } = require('child_process');
        const psCommands = {
            'PlayPause': `(New-Object -ComObject WScript.Shell).SendKeys([char]179)`,
            'Next': `(New-Object -ComObject WScript.Shell).SendKeys([char]176)`,
            'Previous': `(New-Object -ComObject WScript.Shell).SendKeys([char]177)`
        };

        exec(`powershell -command "${psCommands[command]}"`, (error) => {
            if (error) {
                console.error(`Error sending command: ${error}`);
            }
        });
    } catch (error) {
        console.error('Error sending Spotify command:', error);
        vscode.window.showErrorMessage('Failed to control Spotify. Make sure Spotify is running.');
    }
}

function getWebviewContent() {
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, 'webview.html');
    return fs.readFileSync(htmlPath, 'utf8');
}

function deactivate() {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
}

module.exports = {
    activate,
    deactivate
};
