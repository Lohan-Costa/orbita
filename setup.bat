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

REM --- 1/3 Rust ---
where cargo >nul 2>&1
if errorlevel 1 (
  echo [1/3] Rust nao encontrado. Vou instalar.
  echo       ^>^> Se aparecer "Deseja permitir alteracoes?", clique em Sim.
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
) else (
  echo [1/3] Rust ja instalado. Ok.
)

REM --- 2/3 Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [2/3] Node.js nao encontrado. Vou instalar.
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
) else (
  echo [2/3] Node.js ja instalado. Ok.
)

REM --- 3/3 Build tools C++ (necessarias para o Tauri/Rust no Windows) ---
echo [3/3] Verificando ferramentas de compilacao C++.
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

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
