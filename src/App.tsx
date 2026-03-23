import React, { useState, useCallback, useRef } from 'react';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, FileArchive } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export default function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addLog = (message: string) => {
    setLogs((prev) => [...prev, message]);
  };

  const sanitizeFilename = (name: string) => {
    return name.replace(/[<>:"/\\|?*]+/g, '').trim();
  };

  const extractNamesFromText = (items: any[]) => {
    const lines: { [y: number]: { x: number; text: string }[] } = {};

    // Group items by Y coordinate to form lines
    items.forEach((item) => {
      if (!item.str || !item.str.trim()) return;
      const y = Math.round(item.transform[5]);
      const x = Math.round(item.transform[4]);
      const text = item.str.trim();

      // Find an existing line within a 4px tolerance
      let lineY = Object.keys(lines).find((key) => Math.abs(Number(key) - y) <= 4);
      if (!lineY) {
        lineY = y.toString();
        lines[Number(lineY)] = [];
      }
      lines[Number(lineY)].push({ x, text });
    });

    // Sort lines from top to bottom (highest Y to lowest Y)
    const sortedY = Object.keys(lines)
      .map(Number)
      .sort((a, b) => b - a);

    let employer = '';
    let employee = '';
    let foundEmployer = false;

    const cfRegex = /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i;
    const pivaRegex = /^\d{11}$/;

    for (const y of sortedY) {
      // Sort items in the line from left to right
      const lineItems = lines[y].sort((a, b) => a.x - b.x);

      if (!foundEmployer) {
        const empIdx = lineItems.findIndex((i) => pivaRegex.test(i.text) || cfRegex.test(i.text));
        if (empIdx !== -1) {
          employer = lineItems
            .slice(empIdx + 1)
            .map((i) => i.text)
            .join(' ')
            .trim();
          foundEmployer = true;
          continue;
        }
      }

      if (foundEmployer) {
        const empIdx = lineItems.findIndex((i) => cfRegex.test(i.text));
        if (empIdx !== -1) {
          employee = lineItems
            .slice(empIdx + 1)
            .map((i) => i.text)
            .join(' ')
            .trim();
          break;
        }
      }
    }

    return { employer, employee };
  };

  const processPdf = async (file: File) => {
    setIsProcessing(true);
    setLogs([]);
    setProgress(0);
    setError(null);

    try {
      addLog("Caricamento documento per l'analisi delle pagine...");
      const arrayBufferForPdfJs = await file.arrayBuffer();
      const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBufferForPdfJs }).promise;
      const totalPages = pdfJsDoc.numPages;

      addLog(`Documento caricato. Pagine totali: ${totalPages}`);

      addLog('Analisi della struttura del documento in corso...');
      const arrayBufferForPdfLib = await file.arrayBuffer();
      const pdfLibDoc = await PDFDocument.load(arrayBufferForPdfLib);

      const zip = new JSZip();
      let mainEmployerName = 'Datore_Sconosciuto';

      const cuChunks: { start: number; end: number; employer: string; employee: string }[] = [];

      // Phase 1: Analyze pages to find CU boundaries
      for (let i = 1; i <= totalPages; i++) {
        const page = await pdfJsDoc.getPage(i);
        const textContent = await page.getTextContent();
        const textStr = textContent.items.map((item: any) => item.str).join(' ');
        const normalizedText = textStr.replace(/\s+/g, ' ').toUpperCase();

        // Identify the first page of a CU
        const isStartPage =
          normalizedText.includes('DATI RELATIVI AL DATORE') ||
          normalizedText.includes('DATI RELATIVI AL DIPENDENTE') ||
          (normalizedText.includes('CERTIFICAZIONE') && normalizedText.includes('CUI ALL'));

        if (isStartPage) {
          // Close the previous chunk
          if (cuChunks.length > 0) {
            cuChunks[cuChunks.length - 1].end = i - 1;
          }

          // Extract names for the new chunk
          const extracted = extractNamesFromText(textContent.items);
          let employer = extracted.employer || 'Datore_Sconosciuto';
          let employee = extracted.employee || `Dipendente_Sconosciuto_${cuChunks.length + 1}`;

          if (cuChunks.length === 0 || mainEmployerName === 'Datore_Sconosciuto') {
            if (extracted.employer) {
              mainEmployerName = extracted.employer;
            }
          }

          cuChunks.push({
            start: i,
            end: totalPages, // Default to end of document, will be updated if another start page is found
            employer,
            employee,
          });
          
          addLog(`Trovata CU a pagina ${i}: ${employer} - ${employee}`);
        }

        setProgress(Math.round((i / totalPages) * 40)); // 0-40% for analysis
      }

      if (cuChunks.length === 0) {
        throw new Error("Non è stata trovata nessuna Certificazione Unica valida nel documento. Assicurati che sia il modello corretto.");
      }

      addLog(`Analisi completata. Trovate ${cuChunks.length} Certificazioni Uniche. Inizio divisione...`);

      // Phase 2: Split and generate PDFs
      for (let i = 0; i < cuChunks.length; i++) {
        const chunk = cuChunks[i];
        addLog(`Generazione blocco ${i + 1}/${cuChunks.length} (Pagine ${chunk.start}-${chunk.end})...`);

        const safeEmployer = sanitizeFilename(chunk.employer);
        const safeEmployee = sanitizeFilename(chunk.employee);

        const fileName = `CU 2026_${safeEmployer}_${safeEmployee}.pdf`;

        const newPdf = await PDFDocument.create();
        const pageIndices = Array.from({ length: chunk.end - chunk.start + 1 }, (_, k) => chunk.start - 1 + k);
        const copiedPages = await newPdf.copyPages(pdfLibDoc, pageIndices);
        copiedPages.forEach((p) => newPdf.addPage(p));

        const pdfBytes = await newPdf.save();
        zip.file(fileName, pdfBytes);

        setProgress(40 + Math.round(((i + 1) / cuChunks.length) * 50)); // 40-90% for splitting
      }

      addLog('Generazione file ZIP in corso...');
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      const safeMainEmployer = sanitizeFilename(mainEmployerName);
      const suggestedFilename = `CU 2026_${safeMainEmployer}.zip`;

      try {
        // Try to use the File System Access API if available
        if ('showSaveFilePicker' in window) {
          addLog('In attesa della selezione della cartella di salvataggio...');
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: suggestedFilename,
            types: [
              {
                description: 'File ZIP',
                accept: { 'application/zip': ['.zip'] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(zipBlob);
          await writable.close();
          addLog(`File salvato con successo come: ${handle.name}`);
        } else {
          // Fallback for browsers that don't support showSaveFilePicker
          addLog('Download automatico in corso (il tuo browser non supporta la selezione della cartella)...');
          const url = URL.createObjectURL(zipBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = suggestedFilename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          addLog('Salvataggio annullato dall\'utente.');
          throw new Error('Salvataggio annullato.');
        } else {
          console.warn('showSaveFilePicker failed, falling back to standard download:', err);
          addLog('Download automatico in corso (il browser blocca la selezione in questa vista)...');
          const url = URL.createObjectURL(zipBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = suggestedFilename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }

      addLog('Operazione completata con successo!');
      setProgress(100);
    } catch (err: any) {
      console.error(err);
      setError(`Si è verificato un errore: ${err.message || 'Errore sconosciuto'}`);
      addLog(`ERRORE CRITICO: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (isProcessing) return;

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.type === 'application/pdf') {
      processPdf(droppedFile);
    } else {
      setError('Per favore, carica un file PDF valido.');
    }
  }, [isProcessing]);

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      processPdf(selectedFile);
    }
    // Reset input so the same file can be selected again if needed
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl w-full space-y-8">
        <div className="text-center">
          <FileArchive className="mx-auto h-12 w-12 text-indigo-600" />
          <h2 className="mt-6 text-3xl font-extrabold text-slate-900">CU 2026 Splitter</h2>
          <p className="mt-2 text-sm text-slate-600">
            Carica il file PDF unico delle Certificazioni Uniche. Verrà diviso in file da 9 pagine e rinominato automaticamente.
          </p>
        </div>

        <div className="bg-white shadow-xl rounded-2xl p-8">
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onClick={() => !isProcessing && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors duration-200 ${
              isProcessing
                ? 'border-slate-200 bg-slate-50 cursor-not-allowed'
                : 'border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50'
            }`}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInput}
              accept="application/pdf"
              className="hidden"
              disabled={isProcessing}
            />
            {isProcessing ? (
              <div className="flex flex-col items-center space-y-4">
                <Loader2 className="h-10 w-10 text-indigo-600 animate-spin" />
                <p className="text-lg font-medium text-slate-700">Elaborazione in corso...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center space-y-4">
                <Upload className="h-10 w-10 text-indigo-400" />
                <p className="text-lg font-medium text-slate-700">
                  Trascina qui il file PDF oppure clicca per selezionarlo
                </p>
                <p className="text-sm text-slate-500">Solo file .pdf sono supportati</p>
              </div>
            )}
          </div>

          {error && (
            <div className="mt-6 bg-red-50 border-l-4 border-red-500 p-4 rounded-md flex items-start">
              <AlertCircle className="h-5 w-5 text-red-500 mr-3 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {(isProcessing || logs.length > 0) && (
            <div className="mt-8 space-y-4">
              <div>
                <div className="flex justify-between text-sm font-medium text-slate-700 mb-1">
                  <span>Progresso</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2.5">
                  <div
                    className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
              </div>

              <div className="bg-slate-900 rounded-xl p-4 h-64 overflow-y-auto font-mono text-xs text-green-400 shadow-inner">
                {logs.map((log, index) => (
                  <div key={index} className="mb-1">
                    <span className="text-slate-500 mr-2">[{new Date().toLocaleTimeString()}]</span>
                    {log}
                  </div>
                ))}
                {progress === 100 && !error && (
                  <div className="mt-4 flex items-center text-indigo-400 font-bold">
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Operazione completata! Il file ZIP è stato scaricato.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
