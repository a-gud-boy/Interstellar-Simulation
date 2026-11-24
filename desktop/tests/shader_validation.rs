use interstellar_desktop::shaders;

#[test]
fn validate_all_wgsl_shaders_with_wgpu() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .expect("Expected a hardware or software wgpu adapter on Linux");

    println!("Validating shaders on adapter: {:?}", adapter.get_info());

    let (device, _queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("shader-validation-device"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
    }))
    .expect("Failed to request wgpu device");

    for (name, source) in shaders::all_named() {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl((*source).into()),
        });
        let err = pollster::block_on(scope.pop());
        assert!(
            err.is_none(),
            "Shader '{}' failed wgpu/naga validation: {:?}",
            name,
            err
        );
        println!("  [OK] {}", name);
    }
}
