import type {
  AnalysisErrorRecord,
  AnalysisWorkerStatus,
  BackgroundPauseState,
  AssignPersonSelectionResult,
  QwenBenchmarkModel,
  QwenBenchmarkProfile,
  QwenBenchmarkRunResult,
  QwenBenchmarkStageResult,
  PipelineStatus,
  CatalogStats,
  CatalogWatchEvent,
  CatalogWatchSnapshot,
  ExplorerFolderNode,
  ExplorerRoot,
  FolderTreeNode,
  GeoMediaPoint,
  LifeAreaRecord,
  LifeAreaMediaItem,
  ApplyLifeAreaRulesResult,
  LifeAreaMutationResult,
  LifeAreaRuleConditionType,
  ConfirmPersonResult,
  ConfirmPetResult,
  IgnorePersonResult,
  IgnorePetResult,
  DuplicateGroup,
  MediaRecord,
  MediaDetails,
  MergePersonsResult,
  MergePetsResult,
  PersonCorrectionResult,
  PetCorrectionResult,
  SplitPetCandidateResult,
  AssignPetSelectionResult,
  PersonOverview,
  PetOverview,
  RestoreResult,
  ResetCatalogResult,
  RetryAnalysisResult,
  ScanProgress,
  ScanResult,
  SearchFacets,
  SearchFilter,
  SourceRecord,
  ShutdownStatus
} from "../shared/protocol";

declare global {
  interface Window {
    imageSorter: {
      pickSource(): Promise<string | null>;
      openSourceManager(): Promise<{ opened: true }>;
      lifecycle: {
        onShutdownStatus(listener: (status: ShutdownStatus) => void): () => void;
        getBackgroundPauseState(): Promise<BackgroundPauseState>;
        setBackgroundPaused(paused: boolean): Promise<BackgroundPauseState>;
        onBackgroundPauseState(
          listener: (status: BackgroundPauseState) => void
        ): () => void;
      };
      analysis: {
        getStatus(): Promise<AnalysisWorkerStatus>;
        getPipelineStatus(sourceId?: number): Promise<PipelineStatus>;
        openDevLog(): Promise<{ opened: true; path: string }>;
        copyDevLog(): Promise<{
          copied: true;
          path: string;
          characters: number;
        }>;
        clearDevLog(): Promise<{ cleared: true; path: string }>;
        getAutomaticQwenState(): Promise<{ enabled: boolean }>;
        startAutomaticQwen(): Promise<{ enabled: true }>;
        prepareQwenBenchmark(): Promise<{ paused: true }>;
        finishQwenBenchmark(): Promise<{ resumed: true }>;
        pickQwenBenchmarkImage(): Promise<string | null>;
        runQwenBenchmark(
          filePath: string,
          model: QwenBenchmarkModel,
          profiles: QwenBenchmarkProfile[]
        ): Promise<QwenBenchmarkRunResult>;
        onQwenBenchmarkStage(
          listener: (stage: QwenBenchmarkStageResult) => void
        ): () => void;
        listErrors(sourceId?: number, limit?: number): Promise<AnalysisErrorRecord[]>;
        countErrors(sourceId?: number): Promise<number>;
        retryJob(jobId: number): Promise<RetryAnalysisResult>;
        retryAll(sourceId?: number): Promise<RetryAnalysisResult>;
        openFile(mediaId: number): Promise<{ opened: true }>;
        openFolder(mediaId: number): Promise<{ opened: true }>;
        onStatus(listener: (status: AnalysisWorkerStatus) => void): () => void;
        onPipelineStatus(listener: (status: PipelineStatus) => void): () => void;
      };
      people: {
        getOverview(sourceId: number, forceRefresh?: boolean): Promise<PersonOverview>;
        confirmCandidate(
          candidateId: number,
          name: string,
          fallbackFaceDetectionId?: number,
          expectedFaceCount?: number,
          expectedMemberSignature?: string
        ): Promise<ConfirmPersonResult>;
        assignCandidateSelection(
          candidateId: number,
          faceDetectionIds: number[],
          name: string
        ): Promise<AssignPersonSelectionResult>;
        ignoreCandidate(
          candidateId: number,
          fallbackFaceDetectionId?: number,
          expectedFaceCount?: number,
          expectedMemberSignature?: string,
          ignoredIdentityId?: number
        ): Promise<IgnorePersonResult>;
        removeCandidateFace(
          candidateId: number,
          faceDetectionId: number
        ): Promise<PersonCorrectionResult>;
        removePersonFace(
          personId: number,
          faceDetectionId: number
        ): Promise<PersonCorrectionResult>;
        mergePersons(
          targetPersonId: number,
          sourcePersonId: number
        ): Promise<MergePersonsResult>;
        renamePerson(
          personId: number,
          name: string
        ): Promise<PersonCorrectionResult>;
        onUpdated(listener: () => void): () => void;
      };
      pets: {
        getOverview(sourceId: number, forceRefresh?: boolean): Promise<PetOverview>;
        confirmCandidate(
          candidateId: number,
          name: string,
          rejectedPetId?: number,
          fallbackPetDetectionId?: number,
          expectedDetectionCount?: number,
          expectedMemberSignature?: string
        ): Promise<ConfirmPetResult>;
        ignoreCandidate(
          candidateId: number,
          fallbackPetDetectionId?: number,
          expectedDetectionCount?: number,
          expectedMemberSignature?: string,
          ignoredIdentityId?: number
        ): Promise<IgnorePetResult>;
        removeCandidatePet(
          candidateId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        splitCandidate(
          candidateId: number,
          petDetectionIds: number[]
        ): Promise<SplitPetCandidateResult>;
        assignCandidateSelection(
          candidateId: number,
          petDetectionIds: number[],
          name: string
        ): Promise<AssignPetSelectionResult>;
        removePetDetection(
          petId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        confirmPetDetection(
          petId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        mergePets(
          targetPetId: number,
          sourcePetId: number
        ): Promise<MergePetsResult>;
        renamePet(
          petId: number,
          name: string
        ): Promise<PetCorrectionResult>;
        onUpdated(listener: () => void): () => void;
      };
      catalog: {
        listSources(): Promise<SourceRecord[]>;
        addSource(sourcePath: string): Promise<SourceRecord>;
        disableSource(sourceId: number): Promise<SourceRecord>;
        getFolderTree(rootPath: string): Promise<FolderTreeNode>;
        listExplorerRoots(): Promise<ExplorerRoot[]>;
        getExplorerChildren(folderPath: string): Promise<ExplorerFolderNode[]>;
        getStats(sourceId: number): Promise<CatalogStats>;
        getWatchSnapshot(): Promise<CatalogWatchSnapshot>;
        listMedia(sourceId: number, limit?: number): Promise<MediaRecord[]>;
        listGeoMedia(sourceId?: number): Promise<GeoMediaPoint[]>;
        listLifeAreas(): Promise<LifeAreaRecord[]>;
        createLifeArea(name: string): Promise<{ id: number; name: string }>;
        renameLifeArea(
          lifeAreaId: number,
          name: string
        ): Promise<LifeAreaMutationResult>;
        deleteLifeArea(lifeAreaId: number): Promise<LifeAreaMutationResult>;
        addLifeAreaRule(
          lifeAreaId: number,
          conditionType: LifeAreaRuleConditionType,
          conditionValue: string | null,
          dateFrom: string | null,
          dateTo: string | null,
          groupId?: number | null
        ): Promise<{ id: number; groupId: number }>;
        deleteLifeAreaRule(ruleId: number): Promise<LifeAreaMutationResult>;
        setLifeAreaRuleEnabled(
          ruleId: number,
          enabled: boolean
        ): Promise<LifeAreaMutationResult>;
        applyLifeAreaRules(
          lifeAreaId?: number
        ): Promise<ApplyLifeAreaRulesResult>;
        listLifeAreaMedia(lifeAreaId: number): Promise<LifeAreaMediaItem[]>;
        setMediaLifeArea(
          mediaId: number,
          lifeAreaId: number,
          assigned: boolean
        ): Promise<LifeAreaMutationResult>;
        getSearchFacets(sourceId?: number): Promise<SearchFacets>;
        searchMedia(
          sourceId: number | undefined,
          filter: SearchFilter,
          limit?: number
        ): Promise<MediaRecord[]>;
        listDuplicateGroups(sourceId: number, limit?: number): Promise<DuplicateGroup[]>;
        listRecycleMedia(sourceId: number, limit?: number): Promise<MediaRecord[]>;
        getMediaDetails(mediaId: number): Promise<MediaDetails | null>;
        scanSource(sourceId: number): Promise<ScanResult>;
        restoreMedia(mediaId: number): Promise<RestoreResult>;
        resetCatalog(): Promise<ResetCatalogResult>;
        onProgress(listener: (progress: ScanProgress) => void): () => void;
        onWatchEvent(listener: (event: CatalogWatchEvent) => void): () => void;
      };
    };
  }
}

export {};
