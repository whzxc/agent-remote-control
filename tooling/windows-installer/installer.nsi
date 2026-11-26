Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor zlib
SetFont "Microsoft YaHei UI" 9

!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!include nsDialogs.nsh
!include WordFunc.nsh
!include x64.nsh

!define VERSION "${ARC_VERSION}"
!define PRODUCT "Agent Remote Control"
!define DESKTOP "agent-remote-control-desktop.exe"
!define ID "com.whzxc.agent-remote-control"
!define LOCATION "Software\whzxc\${PRODUCT}"
!define UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define PROTOCOL "Software\Classes\agent-remote-control"
!define WEBVIEW2 "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${PRODUCT}"
BrandingText "${PRODUCT}"
OutFile "${ARC_OUTPUT}"
InstallDir "$LOCALAPPDATA\${PRODUCT}"
Icon "${ARC_ICON}"
UninstallIcon "${ARC_ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "LegalCopyright" "whzxc"
VIAddVersionKey "FileDescription" "${PRODUCT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode

!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "203D35"
!include "${ARC_PAGES}"
Page custom ConnectorWelcome ConnectorWelcomeLeave
!insertmacro MUI_PAGE_INSTFILES
Page custom ConnectorFinish ConnectorFinishLeave
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装程序需要 64 位 Windows。"
    Abort
  ${EndIf}
  SetShellVarContext current
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
    SetAutoClose true
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/NS" $1
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ReadRegStr $1 HKCU "${LOCATION}" ""
  ${If} $1 != ""
    StrCpy $INSTDIR $1
  ${EndIf}
  StrCpy $ConnectorDesktopShortcut 1
  ReadRegStr $ConnectorInstalledVersion HKCU "${UNINSTALL}" "DisplayVersion"
  ${If} $ConnectorInstalledVersion != ""
    StrCpy $ConnectorDesktopShortcut 0
    ${VersionCompare} "${VERSION}" "$ConnectorInstalledVersion" $0
    ${If} $0 = 2
      MessageBox MB_ICONSTOP "已安装更新版本，无法降级安装。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function SkipIfPassive
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
FunctionEnd

Function RunMainBinary
  ExecShell "open" "$INSTDIR\${DESKTOP}"
FunctionEnd

Function .onInstSuccess
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/R" $1
    ${IfNot} ${Errors}
      ClearErrors
      ${GetOptions} $0 "/ARGS" $1
      ${If} ${Errors}
        StrCpy $1 ""
      ${EndIf}
      ExecShell "open" "$INSTDIR\${DESKTOP}" "$1"
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "WebView2"
  SetRegView 32
  ReadRegStr $0 HKLM "${WEBVIEW2}" "pv"
  ReadRegStr $1 HKCU "${WEBVIEW2}" "pv"
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    Goto webview_ready
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $1 != "0.0.0.0"
    Goto webview_ready
  ${EndIf}
  InitPluginsDir
  NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe"
  Pop $0
  ${If} $0 != "success"
    Abort "无法下载 Microsoft Edge WebView2。"
  ${EndIf}
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install' $0
  ${If} $0 != 0
    Abort "无法安装 Microsoft Edge WebView2。"
  ${EndIf}
webview_ready:
SectionEnd

Section "Install"
  StrCpy $0 $INSTDIR 2 1
  ${If} $0 != ":\"
    Abort "请选择完整的本地安装路径。"
  ${EndIf}
  StrCpy $2 0
  ; Probe both existing executables before writing anything. The updater has
  ; already asked the old app to quit. Manual installs can retry after it exits.
  ${Do}
    ClearErrors
    IfFileExists "$INSTDIR\${DESKTOP}" 0 +2
      FileOpen $0 "$INSTDIR\${DESKTOP}" a
    ${IfNot} ${Errors}
      IfFileExists "$INSTDIR\${DESKTOP}" 0 +2
        FileClose $0
      IfFileExists "$INSTDIR\bin\arc.exe" 0 install_ready
      FileOpen $0 "$INSTDIR\bin\arc.exe" a
      ${IfNot} ${Errors}
        FileClose $0
        Goto install_ready
      ${EndIf}
    ${EndIf}
    ${If} $PassiveMode = 1
    ${OrIf} ${Silent}
      Sleep 500
      IntOp $2 $2 + 1
      ${If} $2 >= 30
        Abort "请退出 Agent Remote Control 后重试。"
      ${EndIf}
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请退出 Agent Remote Control 后重试。" IDRETRY +2
      Abort
    ${EndIf}
  ${Loop}
install_ready:
  ClearErrors
  SetOutPath "$INSTDIR"
  File /r "${ARC_PAYLOAD_FILES}"
  ${If} ${Errors}
    Abort "无法写入安装文件：$INSTDIR"
  ${EndIf}
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${LOCATION}" "" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL}" "DisplayIcon" "$\"$INSTDIR\${DESKTOP}$\",0"
  WriteRegStr HKCU "${UNINSTALL}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr HKCU "${UNINSTALL}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTALL}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegStr HKCU "${UNINSTALL}" "MainBinaryName" "${DESKTOP}"
  WriteRegStr HKCU "${UNINSTALL}" "Publisher" "whzxc"
  WriteRegDWORD HKCU "${UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL}" "NoRepair" 1
  WriteRegStr HKCU "${PROTOCOL}" "" "URL:${ID} protocol"
  WriteRegStr HKCU "${PROTOCOL}" "URL Protocol" ""
  WriteRegStr HKCU "${PROTOCOL}\DefaultIcon" "" "$\"$INSTDIR\${DESKTOP}$\",0"
  WriteRegStr HKCU "${PROTOCOL}\shell\open\command" "" "$\"$INSTDIR\${DESKTOP}$\" $\"%1$\""
  ${If} $UpdateMode != 1
  ${AndIf} $NoShortcutMode != 1
    CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${DESKTOP}"
    ${If} $ConnectorDesktopShortcut = 1
      CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${DESKTOP}"
    ${EndIf}
  ${EndIf}
  ${If} $UpdateMode != 1
    InitPluginsDir
    File /oname=$PLUGINSDIR\arc-peer-firewall.ps1 "${ARC_PEER_FIREWALL_SCRIPT}"
    ExecShellWait "runas" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\arc-peer-firewall.ps1" -StateDirectory "$LOCALAPPDATA\agent-remote-control"' SW_HIDE
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ClearErrors
  Delete "$INSTDIR\${DESKTOP}"
  ${If} ${Errors}
    Abort "请退出 Agent Remote Control 后重试。"
  ${EndIf}
  !include "${ARC_UNINSTALL_FILES}"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  ReadRegStr $0 HKCU "${PROTOCOL}\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${DESKTOP}$\" $\"%1$\""
    DeleteRegKey HKCU "${PROTOCOL}"
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT}"
  DeleteRegKey HKCU "${UNINSTALL}"
  DeleteRegKey HKCU "${LOCATION}"
  InitPluginsDir
  File /oname=$PLUGINSDIR\arc-peer-firewall.ps1 "${ARC_PEER_FIREWALL_SCRIPT}"
  ExecShellWait "runas" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\arc-peer-firewall.ps1" -StateDirectory "$LOCALAPPDATA\agent-remote-control" -Remove' SW_HIDE
  RMDir "$INSTDIR"
SectionEnd
