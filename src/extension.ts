import * as vscode from 'vscode';
import { ChatManager, EDITOR_VIEW_TYPE } from './chat';
import { runDoctor } from './doctor';

export function activate(ctx: vscode.ExtensionContext): void {
  const chat = new ChatManager(ctx);
  ctx.subscriptions.push(
    chat,
    vscode.window.registerWebviewViewProvider('ccprofile.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    // revives the CC Cadence editor tabs that were open before a window reload
    vscode.window.registerWebviewPanelSerializer(EDITOR_VIEW_TYPE, chat),
    vscode.commands.registerCommand('ccprofile.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('ccprofile.stop', () => chat.stop()),
    vscode.commands.registerCommand('ccprofile.switchProfile', () => chat.switchProfile()),
    vscode.commands.registerCommand('ccprofile.addProfile', () => chat.addProfileCmd()),
    vscode.commands.registerCommand('ccprofile.manageProfiles', () => chat.manageProfilesCmd()),
    vscode.commands.registerCommand('ccprofile.doctor', () => runDoctor(ctx.secrets)),
    vscode.commands.registerCommand('ccprofile.history', () => chat.history()),
    vscode.commands.registerCommand('ccprofile.openHistory', () => chat.openHistory()),
    vscode.commands.registerCommand('ccprofile.open', (resource?: unknown) => chat.openEditorPanel(resource)),
  );
}

export function deactivate(): void {}
