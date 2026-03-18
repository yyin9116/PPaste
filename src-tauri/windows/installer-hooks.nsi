; Custom NSIS hooks for a cleaner, modern-feel install flow

!macro NSIS_HOOK_PREINSTALL
  ; Remove old, cramped default details text and replace with clearer copy.
  ; MUI2 pages do not expose full HTML/CSS styling, but we can improve wording and consistency.
  DetailPrint "Installing ppaste..."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installation completed."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing ppaste..."
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Uninstall completed."
!macroend
