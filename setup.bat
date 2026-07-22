@echo off
chcp 65001 >nul
REM setup.bat — Windows
REM Duplo clique no Explorer abre este arquivo no Prompt.
REM Verifica o que falta, instala so o que falta e roda o Orbita em modo desenvolvedor.

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==================================================
echo   Preparando o ambiente do Orbita (Windows)
echo ==================================================
echo.

REM --- winget disponivel? ---
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERRO] O winget nao foi encontrado.
  echo Abra a Microsoft Store, atualize o "Instalador de Aplicativo" e rode de novo.
  echo.
  pause
  exit /b 1
)

REM --- 1/5 Rust ---
where cargo >nul 2>&1
if errorlevel 1 (
  echo [1/5] Rust nao encontrado. Vou instalar.
  echo       ^>^> Se aparecer "Deseja permitir alteracoes?", clique em Sim.
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
) else (
  echo [1/5] Rust ja instalado. Ok.
)

REM --- 2/5 Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [2/5] Node.js nao encontrado. Vou instalar.
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
) else (
  echo [2/5] Node.js ja instalado. Ok.
)

REM --- 3/5 Build tools C++ (necessarias para o Tauri/Rust no Windows) ---
echo [3/5] Verificando ferramentas de compilacao C++.
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

REM --- 4/6 Python (necessario para construir o sidecar) ---
where python >nul 2>&1
if errorlevel 1 (
  echo [4/6] Python nao encontrado. Vou instalar.
  winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
) else (
  echo [4/6] Python ja instalado. Ok.
)

REM --- 5/6 VLC (motor de video do monitor no Windows) ---
REM NAO e' opcional na pratica: o WebView2 do Windows nao tem decodificador de
REM ProRes (codec da Apple), que e' o material comum de multicamera. Sem VLC o
REM monitor fica preto nesses arquivos. No macOS o WKWebView decodifica ProRes
REM nativamente via AVFoundation, e por isso isso nunca apareceu la'.
REM Falhar aqui NAO aborta: o app roda igual, so' sem monitor, e a propria UI
REM explica que falta o VLC.
REM (O ffmpeg NAO e' instalado no sistema: ele e' EMBARCADO, baixado no passo 6/6.)
if exist "%ProgramFiles%\VideoLAN\VLC\libvlc.dll" (
  echo [5/6] VLC ja instalado. Ok.
) else (
  echo [5/6] VLC nao encontrado. Vou instalar ^(o monitor de video precisa dele^).
  winget install --id VideoLAN.VLC -e --accept-source-agreements --accept-package-agreements
)

set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"

echo.
echo --------------------------------------------------
echo IMPORTANTE: se Rust ou Node acabaram de ser instalados agora,
echo o Windows pode ainda nao reconhece-los nesta janela.
echo Se aparecer erro logo abaixo, FECHE esta janela e
echo de DUPLO CLIQUE no setup.bat de novo. Na segunda vez funciona.
echo --------------------------------------------------
echo.

echo Instalando as dependencias do projeto...
call npm install

REM --- 6/6 Sidecar Python ---
REM src-tauri/binaries/ e' gitignored: o binario do sidecar NUNCA vem do repo,
REM e o `tauri dev` falha com "resource path ... doesn't exist" sem ele. Em CI
REM isso e' um passo explicito (.github/workflows/release.yml); aqui tem que
REM ser tambem, senao toda maquina nova quebra no primeiro build.
echo.
echo [6/6] Verificando o sidecar Python...
for /f "tokens=2" %%i in ('rustc -vV ^| findstr /b "host:"') do set "TRIPLE=%%i"
if not defined TRIPLE (
  echo [ERRO] Nao consegui descobrir o alvo do Rust. O Rust foi instalado agora?
  echo Feche esta janela e rode o setup.bat de novo.
  pause
  exit /b 1
)
if exist "src-tauri\binaries\orbita-python-%TRIPLE%.exe" (
  echo       Sidecar ja construido. Ok.
) else (
  echo       Sidecar nao encontrado. Vou construir ^(demora alguns minutos^).
  python -m pip install -r src-python\requirements-build.txt
  python src-python\build_sidecar.py %TRIPLE%
  if errorlevel 1 (
    echo [ERRO] Falha ao construir o sidecar Python.
    pause
    exit /b 1
  )
)
REM ffmpeg/ffprobe EMBARCADOS: tambem em binaries\ (o externalBin do Tauri exige
REM os arquivos no build). Baixados, nunca instalados no sistema — e' o que faz o
REM app rodar sem ffmpeg na maquina do usuario.
echo       Verificando ffmpeg/ffprobe embarcados...
python src-python\fetch_ffmpeg.py %TRIPLE%
if errorlevel 1 (
  echo [ERRO] Falha ao baixar o ffmpeg/ffprobe embarcados.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Tudo pronto! Iniciando o Orbita em modo desenvolvedor.
echo   Para PARAR o app, pressione Ctrl + C nesta janela.
echo ==================================================
echo.
call npm run tauri dev

echo.
echo O app foi encerrado. Pode fechar esta janela.
pause
