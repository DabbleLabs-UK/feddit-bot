!include "MUI2.nsh"

!ifndef STAGE_DIR
  !error "STAGE_DIR is required"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is required"
!endif

Name "Feddit Bots"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Feddit Bots"
RequestExecutionLevel user
Unicode True
SetCompress off

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\FedditBots.Desktop.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--open-ui"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Section "Feddit Bots" MainSection
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Feddit Bots"
  CreateShortcut "$SMPROGRAMS\Feddit Bots\Feddit Bots.lnk" "$INSTDIR\FedditBots.Desktop.exe" "--open-ui"
  CreateShortcut "$DESKTOP\Feddit Bots.lnk" "$INSTDIR\FedditBots.Desktop.exe" "--open-ui"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Feddit Bots" '"$INSTDIR\FedditBots.Desktop.exe" --background'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FedditBots" "DisplayName" "Feddit Bots"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FedditBots" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FedditBots" "Publisher" "DabbleLabs"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FedditBots" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd

Section "Uninstall"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Feddit Bots"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FedditBots"
  Delete "$SMPROGRAMS\Feddit Bots\Feddit Bots.lnk"
  RMDir "$SMPROGRAMS\Feddit Bots"
  Delete "$DESKTOP\Feddit Bots.lnk"
  RMDir /r "$INSTDIR"
  MessageBox MB_OK "Feddit Bots was removed. Your bot profiles and downloaded models were kept in Local AppData so reinstalling can restore them."
SectionEnd
