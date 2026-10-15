; Native installer pages. Included by installer.nsi after Tauri bundle defines.
!define CONNECTOR_INSTALLER_DIR "${__FILEDIR__}"

; Retire the previous registration before installing, including after an old uninstall.
; The installed desktop only reads and writes the current user's Run entry.
!macro NSIS_HOOK_PREINSTALL
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=retire-startup.ps1 "${CONNECTOR_INSTALLER_DIR}\retire-startup.ps1"
    SetOutPath "$INSTDIR"
    nsExec::ExecToStack /OEM '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\retire-startup.ps1" -ExecutablePath "$INSTDIR\${MAINBINARYNAME}.exe" -ProductName "${PRODUCTNAME}"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "$1"
      SetErrorLevel 1
      Abort "无法清理旧版登录计划任务，安装已停止。请先在旧版客户端关闭登录启动，或在任务计划程序中删除 ChatGPT Local Connector 任务；如提示拒绝访问，请使用管理员权限清理后重试。$\r$\n$1"
    ${EndIf}
!macroend

Var ConnectorDialog
Var ConnectorTitleFont
Var ConnectorIcon
Var ConnectorIconHandle
Var ConnectorPath
Var ConnectorBrowse
Var ConnectorPathLabel
Var ConnectorPathHint
Var ConnectorCustomize
Var ConnectorExpanded
Var ConnectorDesktopControl
Var ConnectorDesktopShortcut
Var ConnectorInstalledVersion

Function ConnectorWelcome
  Call SkipIfPassive
  !insertmacro MUI_HEADER_TEXT "安装 Local Connector" "让 ChatGPT 连接这台电脑上的 Agent"
  nsDialogs::Create 1018
  Pop $ConnectorDialog
  ${If} $ConnectorDialog == error
    Abort
  ${EndIf}
  SetCtlColors $ConnectorDialog 203D35 FFFFFF
  CreateFont $ConnectorTitleFont "Microsoft YaHei UI" 18 600

  ${NSD_CreateIcon} 4u 7u 44u 44u ""
  Pop $ConnectorIcon
  ${NSD_SetIconFromInstaller} $ConnectorIcon $ConnectorIconHandle
  SetCtlColors $ConnectorIcon 203D35 FFFFFF
  ${NSD_CreateLabel} 58u 9u 238u 24u "Local Connector"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $ConnectorTitleFont 1
  SetCtlColors $0 224E43 FFFFFF
  ${NSD_CreateLabel} 60u 38u 234u 14u "ChatGPT 与本机 Agent，在这里连接。"
  Pop $0
  SetCtlColors $0 66756F FFFFFF
  ${NSD_CreateLabel} 4u 61u 292u 14u "版本 ${VERSION} · 为当前用户安装"
  Pop $0
  SetCtlColors $0 66756F FFFFFF
  ${If} $ConnectorInstalledVersion != ""
    ${NSD_SetText} $0 "更新至 ${VERSION} · 保留已有连接配置"
    ${If} $ConnectorInstalledVersion == "${VERSION}"
      ${NSD_SetText} $0 "重新安装 ${VERSION} · 保留已有连接配置"
    ${EndIf}
  ${EndIf}

  ${NSD_CreateLink} 4u 80u 120u 13u "自定义安装 ▾"
  Pop $ConnectorCustomize
  SetCtlColors $ConnectorCustomize 224E43 FFFFFF
  ${NSD_OnClick} $ConnectorCustomize ConnectorTogglePath
  ${NSD_CreateLabel} 4u 98u 292u 12u "安装位置"
  Pop $ConnectorPathLabel
  SetCtlColors $ConnectorPathLabel 66756F FFFFFF
  ${NSD_CreateDirRequest} 4u 111u 236u 14u "$INSTDIR"
  Pop $ConnectorPath
  ${NSD_CreateBrowseButton} 246u 111u 50u 14u "浏览…"
  Pop $ConnectorBrowse
  ${NSD_OnClick} $ConnectorBrowse ConnectorBrowsePath
  ${NSD_CreateLabel} 4u 128u 292u 12u "仅安装到当前用户，无需管理员权限。"
  Pop $ConnectorPathHint
  SetCtlColors $ConnectorPathHint 66756F FFFFFF
  ${If} $ConnectorInstalledVersion != ""
    EnableWindow $ConnectorPath 0
    EnableWindow $ConnectorBrowse 0
    ${NSD_SetText} $ConnectorPathHint "更新沿用已有安装位置。"
  ${EndIf}
  StrCpy $ConnectorExpanded 1
  Push 0
  Call ConnectorTogglePath

  ${NSD_CreateCheckbox} 164u 80u 132u 13u "创建桌面快捷方式"
  Pop $ConnectorDesktopControl
  SetCtlColors $ConnectorDesktopControl 203D35 FFFFFF
  ${NSD_SetState} $ConnectorDesktopControl $ConnectorDesktopShortcut
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $ConnectorInstalledVersion == ""
    ${NSD_SetText} $0 "一键安装"
  ${Else}
    ${NSD_SetText} $0 "一键更新"
  ${EndIf}
  nsDialogs::Show
  ${NSD_FreeIcon} $ConnectorIconHandle
  System::Call 'gdi32::DeleteObject(p $ConnectorTitleFont)'
FunctionEnd

Function ConnectorTogglePath
  Pop $0
  ${If} $ConnectorExpanded == 1
    StrCpy $ConnectorExpanded 0
    StrCpy $1 ${SW_HIDE}
    ${NSD_SetText} $ConnectorCustomize "自定义安装 ▾"
  ${Else}
    StrCpy $ConnectorExpanded 1
    StrCpy $1 ${SW_SHOW}
    ${NSD_SetText} $ConnectorCustomize "收起安装选项 ▴"
  ${EndIf}
  ShowWindow $ConnectorPathLabel $1
  ShowWindow $ConnectorPath $1
  ShowWindow $ConnectorBrowse $1
  ShowWindow $ConnectorPathHint $1
FunctionEnd

Function ConnectorBrowsePath
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $ConnectorPath $0
  ${EndIf}
FunctionEnd

Function ConnectorWelcomeLeave
  ${NSD_GetText} $ConnectorPath $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "请选择安装位置。"
    Abort
  ${EndIf}
  ; Require a full local path; NSIS validates write access when installing.
  StrCpy $1 $0 2 1
  ${If} $1 != ":\"
    MessageBox MB_ICONEXCLAMATION "请选择完整的本地安装路径，例如 C:\Apps\Local Connector。"
    Abort
  ${EndIf}
  ; The directory may not exist yet. GetFullPathName clears its output in
  ; that case, so retain the validated path until SetOutPath creates it.
  StrCpy $INSTDIR $0
  ${NSD_GetState} $ConnectorDesktopControl $ConnectorDesktopShortcut
FunctionEnd

Function ConnectorFinish
  Call SkipIfPassive
  !insertmacro MUI_HEADER_TEXT "安装完成" "Local Connector 已准备就绪"
  nsDialogs::Create 1018
  Pop $ConnectorDialog
  ${If} $ConnectorDialog == error
    Abort
  ${EndIf}
  SetCtlColors $ConnectorDialog 203D35 FFFFFF
  CreateFont $ConnectorTitleFont "Microsoft YaHei UI" 18 600
  ${NSD_CreateIcon} 4u 7u 44u 44u ""
  Pop $ConnectorIcon
  ${NSD_SetIconFromInstaller} $ConnectorIcon $ConnectorIconHandle
  SetCtlColors $ConnectorIcon 203D35 FFFFFF
  ${NSD_CreateLabel} 58u 12u 238u 26u "准备好，开始连接"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $ConnectorTitleFont 1
  SetCtlColors $0 224E43 FFFFFF
  ${NSD_CreateLabel} 4u 67u 292u 30u "启动 Local Connector，管理本机 Agent，$\r$\n并将它们连接到 ChatGPT。"
  Pop $0
  SetCtlColors $0 66756F FFFFFF
  ${NSD_CreateLink} 4u 113u 100u 14u "稍后启动"
  Pop $0
  SetCtlColors $0 224E43 FFFFFF
  ${NSD_OnClick} $0 ConnectorLaunchLater
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_SetText} $0 "立即启动"
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  nsDialogs::Show
  ${NSD_FreeIcon} $ConnectorIconHandle
  System::Call 'gdi32::DeleteObject(p $ConnectorTitleFont)'
FunctionEnd

Function ConnectorFinishLeave
  Call RunMainBinary
FunctionEnd

Function ConnectorLaunchLater
  Pop $0
  Quit
FunctionEnd
