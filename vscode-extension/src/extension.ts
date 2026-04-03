/**
 * HybX Development System — VSCode Extension v0.1.2
 * Hybrid RobotiX
 *
 * Wraps the HybX Development System bin commands over SSH.
 * Stores SSH password securely in VSCode's secret storage.
 *
 * Configuration (VSCode settings):
 *   hybxDev.sshHost    — SSH connection string, default: arduino@unoq.local
 *   hybxDev.appsPath   — Apps directory on board, default: ~/Arduino
 *   hybxDev.sshKeyPath — Path to SSH private key (optional, overrides password)
 *   hybxDev.sshPath    — Full path to ssh binary, default: /usr/bin/ssh
 */

import * as vscode from 'vscode';
import { exec, ChildProcess } from 'child_process';
import * as net from 'net';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let logsProcess: ChildProcess | null = null;
let currentApp: string | null = null;
let appRunning: boolean = false;
let secretStorage: vscode.SecretStorage;

const PASSWORD_KEY = 'hybxDev.sshPassword';

export function activate(context: vscode.ExtensionContext) {
    secretStorage = context.secrets;

    outputChannel = vscode.window.createOutputChannel('HybX');
    outputChannel.show(true);
    outputChannel.appendLine('HybX Development System v0.1.2 ready.');

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
        ['hybxDev.setPassword',   cmdSetPassword],
        ['hybxDev.clearPassword', cmdClearPassword],
    ];

    for (const [id, handler] of commands) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(outputChannel);
}

export function deactivate() { stopLogsProcess(); }

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
// Password management
// ---------------------------------------------------------------------------

async function getPassword(): Promise<string | undefined> {
    // If SSH key is configured, no password needed
    if (sshKeyPath()) { return undefined; }

    let password = await secretStorage.get(PASSWORD_KEY);
    if (!password) {
        password = await vscode.window.showInputBox({
            prompt: `SSH password for ${sshHost()}`,
            password: true,
            placeHolder: 'Enter SSH password',
            title: 'HybX: SSH Password'
        });
        if (password) {
            await secretStorage.store(PASSWORD_KEY, password);
            outputChannel.appendLine('Password saved to secure storage.');
        }
    }
    return password;
}

async function cmdSetPassword() {
    const password = await vscode.window.showInputBox({
        prompt: `SSH password for ${sshHost()}`,
        password: true,
        placeHolder: 'Enter SSH password',
        title: 'HybX: Set SSH Password'
    });
    if (password) {
        await secretStorage.store(PASSWORD_KEY, password);
        vscode.window.showInformationMessage('✓ SSH password saved.');
    }
}

async function cmdClearPassword() {
    await secretStorage.delete(PASSWORD_KEY);
    vscode.window.showInformationMessage('SSH password cleared.');
}

// ---------------------------------------------------------------------------
// SSH execution using sshpass or expect via node net/exec
// We use a pure Node.js approach: spawn ssh, detect password prompt,
// write password to stdin.
// ---------------------------------------------------------------------------

function buildSshArgs(): string[] {
    const args = [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'NumberOfPasswordPrompts=1',
        '-o', 'BatchMode=no'
    ];
    const key = sshKeyPath();
    if (key) { args.push('-i', key); }
    return args;
}

function sshRun(remoteCmd: string, label: string, password?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        outputChannel.show(true);
        outputChannel.appendLine(`\n─── ${label} ───────────────────────────`);

        const args = [...buildSshArgs(), sshHost(), remoteCmd];
        const env = { ...process.env };

        // Use SSH_ASKPASS mechanism on mac/linux
        // Simpler: pipe password via stdin when prompted
        const { spawn } = require('child_process');
        const proc = spawn(sshBinary(), args, {
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        let passwordSent = false;

        proc.stdout.on('data', (d: Buffer) => {
            const text = d.toString();
            stdoutBuf += text;
            outputChannel.append(text);
        });

        proc.stderr.on('data', (d: Buffer) => {
            const text = d.toString();
            stderrBuf += text;

            // Detect password prompt and respond
            if (!passwordSent && password && 
                (text.toLowerCase().includes('password') || text.toLowerCase().includes('assword'))) {
                passwordSent = true;
                proc.stdin.write(password + '\n');
            } else {
                outputChannel.append(text);
            }
        });

        proc.on('close', (code: number) => {
            if (code === 0) {
                resolve();
            } else {
                const msg = `Command exited with code ${code}`;
                outputChannel.appendLine(msg);
                // If auth failed, clear stored password so user is prompted again
                if (stderrBuf.toLowerCase().includes('permission denied') ||
                    stderrBuf.toLowerCase().includes('auth')) {
                    secretStorage.delete(PASSWORD_KEY);
                    outputChannel.appendLine('Authentication failed — password cleared. Try again.');
                }
                reject(new Error(msg));
            }
        });

        proc.on('error', (err: Error) => {
            outputChannel.appendLine(`SSH error: ${err.message}`);
            reject(err);
        });
    });
}

function sshStream(remoteCmd: string, label: string, password?: string): ChildProcess {
    outputChannel.show(true);
    outputChannel.appendLine(`\n─── ${label} ───────────────────────────`);

    const args = [...buildSshArgs(), sshHost(), remoteCmd];
    const { spawn } = require('child_process');
    const proc = spawn(sshBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let passwordSent = false;

    proc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        if (!passwordSent && password &&
            (text.toLowerCase().includes('password') || text.toLowerCase().includes('assword'))) {
            passwordSent = true;
            proc.stdin.write(password + '\n');
        } else {
            outputChannel.append(text);
        }
    });

    proc.on('close', (code: number) => {
        outputChannel.appendLine(`\n[logs ended, exit ${code}]`);
    });
    proc.on('error', (err: Error) => {
        outputChannel.appendLine(`SSH error: ${err.message}`);
    });

    return proc;
}

async function runCmd(remoteCmd: string, label: string): Promise<void> {
    const password = await getPassword();
    return sshRun(remoteCmd, label, password);
}

async function streamCmd(app: string): Promise<ChildProcess> {
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
        const ssh = sshBinary();
        const args = [...buildSshArgs(), sshHost(), `ls -1 ${appsPath()} 2>/dev/null`];

        // Build command with password via stdin trick
        const { spawn } = require('child_process');
        const proc = spawn(ssh, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let passwordSent = false;

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => {
            const text = d.toString();
            if (!passwordSent && password &&
                (text.toLowerCase().includes('password') || text.toLowerCase().includes('assword'))) {
                passwordSent = true;
                proc.stdin.write(password + '\n');
            }
        });

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
    try {
        await runCmd('echo "HybX connected — $(uname -r)"', 'connect');
        vscode.window.showInformationMessage(`✓ Connected to ${sshHost()}`);
    } catch {
        vscode.window.showErrorMessage(
            `Cannot connect to ${sshHost()}. Use "HybX: Set SSH Password" if you haven't set your password yet.`
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
        logsProcess = await streamCmd(app);
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
        logsProcess = await streamCmd(app);
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
    logsProcess = await streamCmd(currentApp);
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
        logsProcess = await streamCmd(app);
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
