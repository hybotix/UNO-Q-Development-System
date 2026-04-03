/**
 * HybX Development System — VSCode Extension v0.1.6
 * Hybrid RobotiX
 *
 * Uses SSH_ASKPASS to pass password non-interactively on Mac/Linux.
 * Password stored securely in VSCode secret storage.
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let logsProcess: ChildProcess | null = null;
let currentApp: string | null = null;
let appRunning: boolean = false;
let secretStorage: vscode.SecretStorage;
let askpassScript: string | null = null;

const PASSWORD_KEY = 'hybxDev.sshPassword';

export function activate(context: vscode.ExtensionContext) {
    secretStorage = context.secrets;

    outputChannel = vscode.window.createOutputChannel('HybX');
    outputChannel.show(true);
    outputChannel.appendLine('HybX Development System v0.1.6 ready.');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'hybxDev.start';
    updateStatusBar();
    statusBarItem.show();

    const commands: [string, () => void | Promise<void>][] = [
        ['hybxDev.connect',       cmdConnect],
        ['hybxDev.start',         cmdStart],
        ['hybxDev.stop',          cmdStop],
        ['hybxDev.restart',       cmdRestart],
        ['hybxDev.logs',          cmdLogs],
        ['hybxDev.build',         cmdBuild],
        ['hybxDev.addlib',        cmdAddlib],
        ['hybxDev.listApps',      cmdListApps],
        ['hybxDev.clean',         cmdClean],
        ['hybxDev.newrepo',       cmdNewrepo],
        ['hybxDev.clearPassword', cmdClearPassword],
    ];

    for (const [id, handler] of commands) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(outputChannel);
}

export function deactivate() {
    stopLogsProcess();
    cleanupAskpass();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('hybxDev');
}
function sshHost(): string  { return cfg().get<string>('sshHost', 'arduino@unoq.local'); }
function appsPath(): string { return cfg().get<string>('appsPath', '~/Arduino'); }
function sshKeyPath(): string { return cfg().get<string>('sshKeyPath', ''); }
function sshBinary(): string { return cfg().get<string>('sshPath', '/usr/bin/ssh'); }

// ---------------------------------------------------------------------------
// SSH_ASKPASS script — writes password to a temp shell script that SSH calls
// ---------------------------------------------------------------------------

async function ensureAskpass(password: string): Promise<string> {
    const scriptPath = path.join(os.tmpdir(), 'hybx_askpass.sh');
    const escaped = password.replace(/'/g, "'\\''");
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${escaped}'\n`, { mode: 0o700 });
    return scriptPath;
}

function cleanupAskpass() {
    try {
        const scriptPath = path.join(os.tmpdir(), 'hybx_askpass.sh');
        if (fs.existsSync(scriptPath)) { fs.unlinkSync(scriptPath); }
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Password management
// ---------------------------------------------------------------------------

async function getPassword(): Promise<string | undefined> {
    if (sshKeyPath()) { return undefined; }
    let password = await secretStorage.get(PASSWORD_KEY);
    if (!password) {
        password = await vscode.window.showInputBox({
            prompt: `SSH password for ${sshHost()}`,
            password: true,
            placeHolder: 'Enter SSH password',
            title: 'HybX: SSH Password',
            ignoreFocusOut: true
        });
        if (password) {
            await secretStorage.store(PASSWORD_KEY, password);
            outputChannel.appendLine('Password saved to secure storage.');
        }
    }
    return password;
}

async function cmdClearPassword() {
    await secretStorage.delete(PASSWORD_KEY);
    cleanupAskpass();
    vscode.window.showInformationMessage('SSH password cleared.');
}

// ---------------------------------------------------------------------------
// SSH execution via SSH_ASKPASS
// ---------------------------------------------------------------------------

function buildSshArgs(): string[] {
    const args = [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'NumberOfPasswordPrompts=1',
        '-o', 'PreferredAuthentications=password',
        '-o', 'BatchMode=no'
    ];
    const key = sshKeyPath();
    if (key) {
        args.push('-i', key);
    }
    return args;
}

async function buildEnv(password?: string): Promise<NodeJS.ProcessEnv> {
    const env = { ...process.env };
    if (password && !sshKeyPath()) {
        const askpass = await ensureAskpass(password);
        env['SSH_ASKPASS'] = askpass;
        env['SSH_ASKPASS_REQUIRE'] = 'force';
        env['DISPLAY'] = env['DISPLAY'] || 'none';
    }
    return env;
}

function sshRun(remoteCmd: string, label: string, password?: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        outputChannel.show(true);
        outputChannel.appendLine(`\n─── ${label} ───────────────────────────`);

        const args = [...buildSshArgs(), sshHost(), remoteCmd];
        const env = await buildEnv(password);

        const proc = spawn(sshBinary(), args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
        proc.stderr.on('data', (d: Buffer) => {
            const text = d.toString();
            outputChannel.append(text);
            // If auth failed, clear password so user is prompted again
            if (text.toLowerCase().includes('permission denied') ||
                text.toLowerCase().includes('auth fail')) {
                secretStorage.delete(PASSWORD_KEY);
                cleanupAskpass();
            }
        });

        proc.on('close', (code: number) => {
            if (code === 0) { resolve(); }
            else {
                const msg = `Command exited with code ${code}`;
                outputChannel.appendLine(msg);
                reject(new Error(msg));
            }
        });
        proc.on('error', (err: Error) => {
            outputChannel.appendLine(`SSH error: ${err.message}`);
            reject(err);
        });
    });
}

function sshStream(remoteCmd: string, label: string, password?: string): Promise<ChildProcess> {
    return new Promise(async (resolve) => {
        outputChannel.show(true);
        outputChannel.appendLine(`\n─── ${label} ───────────────────────────`);

        const args = [...buildSshArgs(), sshHost(), remoteCmd];
        const env = await buildEnv(password);

        const proc = spawn(sshBinary(), args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
        proc.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));
        proc.on('close', (code: number) => {
            outputChannel.appendLine(`\n[logs ended, exit ${code}]`);
        });
        proc.on('error', (err: Error) => {
            outputChannel.appendLine(`SSH error: ${err.message}`);
        });

        resolve(proc);
    });
}

async function runCmd(remoteCmd: string, label: string): Promise<void> {
    const password = await getPassword();
    return sshRun(remoteCmd, label, password);
}

async function startStream(app: string): Promise<ChildProcess> {
    const password = await getPassword();
    return sshStream(`logs ${app}`, `logs ${app}`, password);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatusBar() {
    if (currentApp && appRunning) {
        statusBarItem.text = `$(play) HybX: ${currentApp}`;
        statusBarItem.tooltip = 'HybX app running — click to start/pick app';
        statusBarItem.backgroundColor = undefined;
    } else if (currentApp && !appRunning) {
        statusBarItem.text = `$(debug-stop) HybX: ${currentApp} (stopped)`;
        statusBarItem.tooltip = 'HybX app stopped — click to start';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = `$(circuit-board) HybX`;
        statusBarItem.tooltip = 'HybX Development System — click to start an app';
        statusBarItem.backgroundColor = undefined;
    }
}

// ---------------------------------------------------------------------------
// App picker
// ---------------------------------------------------------------------------

async function pickApp(): Promise<string | undefined> {
    return new Promise(async (resolve) => {
        const password = await getPassword();
        const args = [...buildSshArgs(), sshHost(), `ls -1 ${appsPath()} 2>/dev/null`];
        const env = await buildEnv(password);

        const proc = spawn(sshBinary(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.on('close', () => {
            let items: string[] = [];
            if (stdout.trim()) { items = stdout.trim().split('\n').filter(Boolean); }
            items.push('$(edit) Enter app name manually...');

            vscode.window.showQuickPick(items, {
                placeHolder: 'Select an app or enter manually',
                title: 'HybX: Pick App'
            }).then(async (sel) => {
                if (!sel) { resolve(undefined); return; }
                if (sel.startsWith('$(edit)')) {
                    const manual = await vscode.window.showInputBox({
                        prompt: 'App name (e.g. matrix-bno)',
                        placeHolder: 'matrix-bno'
                    });
                    resolve(manual);
                } else { resolve(sel); }
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdConnect() {
    outputChannel.show(true);
    outputChannel.appendLine(`\n─── connect ────────────────────────────`);
    outputChannel.appendLine(`SSH binary: ${sshBinary()}`);
    outputChannel.appendLine(`Host: ${sshHost()}`);
    outputChannel.appendLine(`Key path: '${sshKeyPath()}'`);
    const pw = await secretStorage.get(PASSWORD_KEY);
    outputChannel.appendLine(`Stored password: ${pw ? '[SET]' : '[NOT SET]'}`);
    try {
        await runCmd('echo "HybX connected — $(uname -r)"', 'connect');
        vscode.window.showInformationMessage(`✓ Connected to ${sshHost()}`);
    } catch {
        vscode.window.showErrorMessage(
            `Cannot connect to ${sshHost()}. Check the HybX output panel for details.`
        );
    }
}

async function cmdStart() {
    const app = await pickApp();
    if (!app) { return; }
    stopLogsProcess();
    currentApp = app; appRunning = false; updateStatusBar();
    try {
        await runCmd(`start ${app}`, `start ${app}`);
        appRunning = true; updateStatusBar();
        logsProcess = await startStream(app);
    } catch {
        vscode.window.showErrorMessage(`start ${app} failed.`);
        updateStatusBar();
    }
}

async function cmdStop() {
    stopLogsProcess();
    const app = currentApp || await pickApp();
    if (!app) { return; }
    try {
        await runCmd(`stop ${app}`, `stop ${app}`);
        appRunning = false; updateStatusBar();
    } catch { vscode.window.showErrorMessage('stop failed.'); }
}

async function cmdRestart() {
    const app = currentApp || await pickApp();
    if (!app) { return; }
    stopLogsProcess();
    currentApp = app; appRunning = false; updateStatusBar();
    try {
        await runCmd(`restart ${app}`, `restart ${app}`);
        appRunning = true; updateStatusBar();
        logsProcess = await startStream(app);
    } catch {
        vscode.window.showErrorMessage(`restart ${app} failed.`);
        updateStatusBar();
    }
}

async function cmdLogs() {
    if (!currentApp) {
        vscode.window.showWarningMessage('No app running. Use HybX: Start App first.');
        return;
    }
    stopLogsProcess();
    logsProcess = await startStream(currentApp);
}

async function cmdBuild() {
    const sketch = await vscode.window.showInputBox({
        prompt: 'Sketch path on board (e.g. ~/Arduino/matrix-bno/sketch)',
        placeHolder: '~/Arduino/matrix-bno/sketch',
        value: currentApp ? `${appsPath()}/${currentApp}/sketch` : ''
    });
    if (!sketch) { return; }
    try {
        await runCmd(`build ${sketch}`, `build ${sketch}`);
        vscode.window.showInformationMessage(`✓ Build complete: ${sketch}`);
    } catch { vscode.window.showErrorMessage('Build failed.'); }
}

async function cmdAddlib() {
    const action = await vscode.window.showQuickPick(
        ['search', 'install', 'list', 'upgrade'],
        { placeHolder: 'addlib action', title: 'HybX: Add Library' }
    );
    if (!action) { return; }
    if (action === 'list' || action === 'upgrade') {
        await runCmd(`addlib ${action}`, `addlib ${action}`);
        return;
    }
    const libName = await vscode.window.showInputBox({
        prompt: `Library name to ${action}`,
        placeHolder: 'Adafruit SCD30'
    });
    if (!libName) { return; }
    await runCmd(`addlib ${action} "${libName}"`, `addlib ${action} ${libName}`);
}

async function cmdListApps() { await runCmd('list', 'list apps'); }

async function cmdClean() {
    const app = currentApp || await pickApp();
    if (!app) { return; }
    stopLogsProcess();
    const confirm = await vscode.window.showWarningMessage(
        `Clean will nuke Docker + cache for "${app}" and restart. Continue?`,
        'Yes', 'No'
    );
    if (confirm !== 'Yes') { return; }
    try {
        await runCmd(`clean ${app}`, `clean ${app}`);
        appRunning = true; updateStatusBar();
        logsProcess = await startStream(app);
    } catch { vscode.window.showErrorMessage('clean failed.'); }
}

async function cmdNewrepo() {
    const confirm = await vscode.window.showWarningMessage(
        'newrepo will wipe ~/Arduino and ~/bin on the board and re-clone from GitHub. Continue?',
        'Yes', 'No'
    );
    if (confirm !== 'Yes') { return; }
    stopLogsProcess();
    currentApp = null; appRunning = false; updateStatusBar();
    try {
        await runCmd('newrepo', 'newrepo bootstrap');
        vscode.window.showInformationMessage('✓ newrepo complete — board environment rebuilt.');
    } catch { vscode.window.showErrorMessage('newrepo failed.'); }
}

function stopLogsProcess() {
    if (logsProcess) { logsProcess.kill(); logsProcess = null; }
}
