@echo off
REM 7za wrapper - replaces -snld with -snl- to fix symlink on Windows
set ORIG_7ZA=H:\LuminaLife2.0\node_modules\7zip-bin\win\x64\7za.exe

REM Build new arg list: replace -snld with -snl-
set NEW_ARGS=
:loop
if "%~1"=="" goto :execute
if "%~1"=="-snld" (
    set "NEW_ARGS=%NEW_ARGS% -snl-"
) else (
    set "NEW_ARGS=%NEW_ARGS% %1"
)
shift
goto :loop

:execute
"%ORIG_7ZA%" %NEW_ARGS%
exit /b 0
